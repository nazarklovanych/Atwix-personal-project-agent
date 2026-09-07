import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  createBashTool,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { WebClient } from "@slack/web-api";
import type { ProjectConfig } from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import { checkCommand } from "./sqlguard.js";
import { postToThread } from "./slack.js";

export interface InvestigationTarget {
  client: WebClient;
  channel: string;
  /** Thread to post interim updates into (root message ts) */
  threadTs: string;
}

export class InvestigationTimeoutError extends Error {
  constructor(public partial: string) {
    super("investigation timed out");
  }
}

interface CachedSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any;
  lastUsed: number;
}

const SESSION_IDLE_TTL_MS = 60 * 60 * 1000; // 60 min
const sessions = new Map<string, CachedSession>();

export const WORKSPACE = process.env.PPA_WORKSPACE ?? "/work";

/**
 * Dedicated agent dir so PPA does NOT inherit the operator's interactive pi
 * setup (~/.pi/agent), which may include permission-approval extensions that
 * cannot be satisfied from Slack and would block every tool call.
 */
async function ensureAgentDir(): Promise<string> {
  if (process.env.PPA_AGENT_DIR) return process.env.PPA_AGENT_DIR;
  const dir = path.join(os.homedir(), ".pi", "agent-ppa");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, "settings.json"), "{}\n", { flag: "wx" });
  } catch {
    /* already exists */
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

let cachedRuntime: Awaited<ReturnType<typeof ModelRuntime.create>> | undefined;

async function resolveModel(config: ProjectConfig) {
  cachedRuntime ??= await ModelRuntime.create();
  const spec = process.env.PPA_MODEL ?? config.defaults.model; // "provider/id"
  if (spec) {
    const [provider, ...rest] = spec.split("/");
    const id = rest.join("/");
    const model = cachedRuntime.getModel(provider, id);
    if (model) {
      const status = await cachedRuntime.checkAuth(provider);
      if (!status || status.source === "none") {
        throw new Error(
          `model "${spec}" is configured but no API key/auth found for provider "${provider}". ` +
            `Set its API key env var (e.g. ZAI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY) in .env and restart.`,
        );
      }
      return model;
    }
    console.warn(`PPA: model "${spec}" not found, falling back to default`);
  }
  const available = await cachedRuntime.getAvailable();
  if (!available || available.length === 0)
    throw new Error("no LLM available — set ANTHROPIC_API_KEY / OPENAI_API_KEY or PPA_MODEL");
  return available[0];
}

// ---------------------------------------------------------------------------
// Session management per Slack thread
// ---------------------------------------------------------------------------

function evictIdleSessions(): void {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_IDLE_TTL_MS) {
      try {
        entry.session.dispose();
      } catch {
        /* ignore */
      }
      sessions.delete(key);
    }
  }
}

function assistantTextFromMessages(messages: unknown[]): string {
  // Walk backwards for the last assistant message carrying text content.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: Array<{ type: string; text?: string }> };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * Run one investigation turn. Sessions are cached per thread_ts so follow-up
 * mentions in the same Slack thread continue the same conversation.
 */
export async function runInvestigation(
  config: ProjectConfig,
  target: InvestigationTarget,
  userText: string,
): Promise<{ finalText: string; timedOut: boolean; toolTrail: string[] }> {
  evictIdleSessions();

  let cached = sessions.get(target.threadTs);

  if (!cached) {
    await mkdir(WORKSPACE, { recursive: true });
    const agentDir = await ensureAgentDir();

    const model = await resolveModel(config);

    // Custom tool: lets the agent post interim findings into the Slack thread.
    const slackPostUpdate = defineTool({
      name: "slack_post_update",
      label: "Post update to Slack",
      description:
        "Post a short interim progress update or significant discovery into the Slack thread you are answering. " +
        "Use this when the investigation takes a while or when you find something noteworthy mid-way. " +
        "Do not use it for the final answer — the final answer is sent automatically.",
      parameters: Type.Object({
        text: Type.String({ description: "Update text (markdown ok, keep it short)" }),
      }),
      execute: async (_toolCallId, params) => {
        await postToThread(target.client, target.channel, target.threadTs, `:pushpin: ${params.text}`);
        return { content: [{ type: "text", text: "posted" }], details: {} };
      },
    });

    // Guarded bash: identical to the built-in tool, but rejects write SQL
    // (INSERT/UPDATE/DELETE/DDL/admin) before the command ever executes.
    const innerBash = createBashTool(WORKSPACE);
    const guardedBash = defineTool({
      name: "bash",
      label: "Bash",
      description:
        "Execute bash commands. Commands that send write statements to MySQL/MariaDB " +
        "(INSERT, UPDATE, DELETE, DDL, admin ops) are rejected by a hard guard — only " +
        "SELECT/SHOW/EXPLAIN/DESCRIBE queries are permitted.",
      parameters: innerBash.parameters as never,
      execute: async (toolCallId, params, ...rest) => {
        const cmd = String((params as { command?: string }).command ?? "");
        const guard = checkCommand(cmd);
        if (!guard.ok) {
          console.warn(`[ppa:guard] ${guard.reason} — command: ${cmd.slice(0, 200)}`);
          return {
            content: [{ type: "text", text: `COMMAND BLOCKED: ${guard.reason}` }],
            isError: true,
            details: {},
          } as never;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (innerBash.execute as any)(toolCallId, params, ...rest);
      },
    });

    const loader = new DefaultResourceLoader({
      cwd: WORKSPACE,
      agentDir,
      systemPromptOverride: () => buildSystemPrompt(config),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: WORKSPACE,
      model,
      tools: ["read", "bash", "grep", "find", "ls"], // "bash" = our guarded custom tool; no edit/write
      customTools: [guardedBash, slackPostUpdate],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(WORKSPACE),
    });

    cached = { session, lastUsed: Date.now() };
    sessions.set(target.threadTs, cached);
  }

  cached.lastUsed = Date.now();
  const session = cached.session;

  let timedOut = false;
  let finalText = "";
  let lastError: string | undefined;
  const toolTrail: string[] = [];

  // Track latest assistant text + errors from the event stream,
  // and log tool activity so the operator can watch the investigation live.
  const verbose = process.env.PPA_VERBOSE !== "0";
  const unsubscribe = session.subscribe((event: Record<string, unknown>) => {
    if (event.type === "tool_execution_start") {
      const e = event as { toolName?: string; args?: Record<string, unknown> };
      const arg = e.args && typeof e.args === "object" ? Object.values(e.args)[0] : undefined;
      const detail = typeof arg === "string" ? arg.slice(0, 120).replace(/\s+/g, " ") : "";
      const label = `${e.toolName ?? "?"}${detail ? `: ${detail}` : ""}`;
      toolTrail.push(label);
      console.log(`[ppa:tool] ${label}`);
    }
    if (event.type === "tool_execution_end") {
      const e = event as { toolName?: string; isError?: boolean };
      if (e.isError) console.warn(`[ppa:tool] ${e.toolName ?? "?"} errored`);
    }
    if (event.type === "turn_start" && verbose) {
      console.log(`[ppa:turn] model thinking...`);
    }
    if (event.type === "agent_end") {
      const messages = (event as { messages?: unknown[] }).messages ?? [];
      const text = assistantTextFromMessages(messages);
      if (text) finalText = text;
    }
    if (event.type === "turn_end") {
      const msg = (event as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
      if (msg?.content) {
        const text = msg.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) finalText = text;
      }
    }
    if (event.type === "message_end") {
      const msg = (event as { message?: { errorMessage?: string } }).message;
      if (msg?.errorMessage) lastError = msg.errorMessage;
    }
  });

  const timeoutMs = config.defaults.timeout_minutes * 60 * 1000;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const result = await Promise.race([session.prompt(userText), timeoutPromise]);
    if (result === "timeout") {
      timedOut = true;
      await session.abort().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    unsubscribe();
    cached.lastUsed = Date.now();
    console.log(`[ppa:done] thread ${target.threadTs}${timedOut ? " (timed out)" : ""}`);
  }

  if (timedOut) {
    return {
      finalText: finalText || "",
      timedOut: true,
      toolTrail,
    };
  }

  if (!finalText) {
    throw new Error(lastError ?? "agent produced no final answer");
  }

  return { finalText, timedOut: false, toolTrail };
}

/** Drop the cached session for a thread (used when the session is unusable). */
export function forgetSession(threadTs: string): void {
  const entry = sessions.get(threadTs);
  if (entry) {
    try {
      entry.session.dispose();
    } catch {
      /* ignore */
    }
    sessions.delete(threadTs);
  }
}
