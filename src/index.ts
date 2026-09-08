import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { App } from "@slack/bolt";
import type { ProjectConfig } from "./config.js";
import { loadConfig, validateDatabaseSecrets } from "./config.js";
import { forgetSession, runInvestigation, InvestigationTimeoutError, verifyToolEnv } from "./agent.js";
import {
  addReaction,
  assertTokens,
  CHECK,
  CROSS,
  EYES,
  HOURGLASS,
  IN_PROGRESS,
  IN_PROGRESS_AFTER_MS,
  postToThread,
  removeReaction,
  stripBotMention,
} from "./slack.js";

const CONFIG_PATH = process.env.PPA_CONFIG ?? "/app/ppa.yml";

/**
 * Load .env ourselves so local runs match Docker semantics (compose env_file).
 * Values from .env OVERRIDE inherited shell exports — the file is the source
 * of truth and stale shell exports can't silently break DB auth.
 */
function loadEnvFile(): void {
  const candidates = [join(dirname(resolve(CONFIG_PATH)), ".env"), join(process.cwd(), ".env")];
  const path = candidates.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!path) {
    console.warn("[ppa] no .env found next to ppa.yml or in cwd — relying on inherited environment");
    return;
  }
  let loaded = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value; // intentional override
    loaded++;
  }
  console.log(`[ppa] loaded ${loaded} vars from ${path}`);
}

async function main() {
  loadEnvFile();
  const config = loadConfig(CONFIG_PATH);
  validateDatabaseSecrets(config);
  await verifyToolEnv(config.databases.map((db) => db.password_env));
  const { botToken, appToken } = assertTokens();

  const app = new App({
    token: botToken,
    socketMode: true,
    appToken,
  });

  console.log(`[ppa] project: ${config.name}`);
  console.log(
    `[ppa] repos=${config.repos.length} servers=${config.servers.length} dbs=${config.databases.length}`,
  );
  console.log(`[ppa] timeout: ${config.defaults.timeout_minutes} min`);

  app.event("app_mention", async ({ event, client, logger }) => {
    try {
      // Channel allowlist (avoids cross-talk when one Slack app serves many projects)
      if (config.slack_channel_ids?.length && !config.slack_channel_ids.includes(event.channel)) {
        logger.info(`ignoring mention in unconfigured channel ${event.channel}`);
        return;
      }

      const userText = stripBotMention(event.text);
      if (!userText) {
        await postToThread(
          client,
          event.channel,
          event.thread_ts ?? event.ts,
          "Yes? Describe what I should investigate :mag:",
        );
        return;
      }

      const threadTs = event.thread_ts ?? event.ts; // follow-ups stay in one thread = one session
      console.log(`[ppa] investigation started (thread ${threadTs}): ${userText.slice(0, 120)}`);

      await addReaction(client, event.channel, threadTs, EYES);

      // Long investigations: after 3 min, swap 👀 for 🔄 so the channel sees it's still working
      let switchedToProgress = false;
      const progressTimer = setTimeout(async () => {
        switchedToProgress = true;
        await removeReaction(client, event.channel, threadTs, EYES);
        await addReaction(client, event.channel, threadTs, IN_PROGRESS);
      }, IN_PROGRESS_AFTER_MS);

      try {
        const { finalText, timedOut, toolTrail } = await runInvestigation(
          config,
          { client, channel: event.channel, threadTs },
          userText,
        );

        if (timedOut) {
          // Show what was actually done, not the model's mid-stream musing.
          const lastSteps = toolTrail.slice(-8);
          const steps =
            lastSteps.length > 0
              ? `\n\n*What I was doing (last ${lastSteps.length} steps):*\n` +
                lastSteps.map((s) => `• ${s}`).join("\n")
              : "";
          await postToThread(
            client,
            event.channel,
            threadTs,
            `:hourglass_flowing_sand: *Timed out* after ${config.defaults.timeout_minutes} min. ` +
              `The investigation is still in my head — reply *continue* in this thread and I'll pick up where I left off.` +
              steps +
              `\n\n_Tip: raise_ defaults.timeout_minutes _in ppa.yml for deep-dives._`,
          );
          await addReaction(client, event.channel, threadTs, HOURGLASS);
        } else {
          await postToThread(client, event.channel, threadTs, finalText);
          await addReaction(client, event.channel, threadTs, CHECK);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof InvestigationTimeoutError) forgetSession(threadTs);
        await postToThread(
          client,
          event.channel,
          threadTs,
          `:x: Investigation failed: ${msg}`,
        );
        await addReaction(client, event.channel, threadTs, CROSS);
      } finally {
        clearTimeout(progressTimer);
        await removeReaction(client, event.channel, threadTs, switchedToProgress ? IN_PROGRESS : EYES);
      }
    } catch (e) {
      console.error("[ppa] handler error:", e);
    }
  });

  await app.start();
  console.log("[ppa] ⚡ Personal Project Agent is connected to Slack (Socket Mode)");
}

main().catch((e) => {
  console.error("[ppa] fatal:", e);
  process.exit(1);
});
