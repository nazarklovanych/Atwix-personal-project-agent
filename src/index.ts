import { App } from "@slack/bolt";
import type { ProjectConfig } from "./config.js";
import { loadConfig, validateDatabaseSecrets } from "./config.js";
import { forgetSession, runInvestigation, InvestigationTimeoutError } from "./agent.js";
import {
  addReaction,
  assertTokens,
  CHECK,
  CROSS,
  EYES,
  HOURGLASS,
  postToThread,
  removeReaction,
  stripBotMention,
} from "./slack.js";

const CONFIG_PATH = process.env.PPA_CONFIG ?? "/app/ppa.yml";

async function main() {
  const config = loadConfig(CONFIG_PATH);
  validateDatabaseSecrets(config);
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

      try {
        const { finalText, timedOut } = await runInvestigation(config, { client, channel: event.channel, threadTs }, userText);

        if (timedOut) {
          await postToThread(
            client,
            event.channel,
            threadTs,
            `:hourglass_flowing_sand: *Timed out* after ${config.defaults.timeout_minutes} min. ` +
              (finalText ? `Partial findings so far:\n\n${finalText}` : "No partial findings were collected. Try a narrower question or raise `defaults.timeout_minutes` in ppa.yml."),
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
        await removeReaction(client, event.channel, threadTs, EYES);
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
