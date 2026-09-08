import type { App } from "@slack/bolt";
import type { KnownBlock, WebClient } from "@slack/web-api";

export const EYES = "eyes";
export const CHECK = "white_check_mark";
export const CROSS = "x";
export const HOURGLASS = "hourglass_flowing_sand";
export const IN_PROGRESS = "arrows_counterclockwise";

/** After this long, swap 👀 for 🔄 to signal a long-running investigation. */
export const IN_PROGRESS_AFTER_MS = 3 * 60 * 1000;

/** Max characters for a single Slack message body we are willing to post. */
const MAX_MSG_LEN = 35000;
const MAX_BLOCKS = 45; // Slack API limit is 50; leave headroom

/**
 * Convert lightweight markdown to Slack Block Kit blocks for structured output:
 *   # / ## / ### headings  → bold section headers
 *   ``` fenced code ```   → code blocks
 *   > quote lines          → context blocks
 *   other lines            → mrkdwn sections (grouped)
 * Falls back gracefully: anything odd becomes a plain section.
 */
export function mdToBlocks(md: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const lines = md.split("\n");
  let textBuf: string[] = [];

  const flushText = () => {
    const text = textBuf.join("\n").trim();
    if (text) blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    textBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      flushText();
      if (blocks.length > 0) blocks.push({ type: "divider" });
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: heading[1].replace(/[*_`]/g, "").slice(0, 150) },
      });
      continue;
    }
    if (line.trim().startsWith("```")) {
      // No standalone code block type in classic Block Kit — keep fences in the
      // mrkdwn section; Slack renders ``` inside mrkdwn as preformatted code.
      textBuf.push(line);
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        textBuf.push(lines[i]);
        i++;
      }
      textBuf.push(lines[i] ?? "```");
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushText();
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: line.replace(/^>\s?/, "").slice(0, 1900) }] });
      continue;
    }
    textBuf.push(line);
  }
  flushText();
  return blocks.slice(0, MAX_BLOCKS);
}

function trim(text: string): string {
  if (text.length <= MAX_MSG_LEN) return text;
  return (
    text.slice(0, MAX_MSG_LEN) +
    "\n\n…(output truncated — ask a follow-up for the rest)"
  );
}

export async function addReaction(
  client: WebClient,
  channel: string,
  ts: string,
  name: string,
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp: ts, name });
  } catch (e) {
    // "already_reacted" and similar are fine to swallow
    const data = e as { data?: { error?: string } };
    if (data?.data?.error && data.data.error !== "already_reacted") {
      console.warn(`reactions.add(${name}) failed:`, data.data.error);
    }
  }
}

export async function removeReaction(
  client: WebClient,
  channel: string,
  ts: string,
  name: string,
): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp: ts, name });
  } catch {
    // ignore (e.g. reaction not present)
  }
}

/** Post a message into the same thread as ts. Uses Block Kit formatting. Returns the posted message ts. */
export async function postToThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string | undefined> {
  const trimmed = trim(text);
  const blocks = mdToBlocks(trimmed);
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: trimmed.slice(0, 2900), // fallback/preview text for notifications
    blocks: blocks.length > 0 ? blocks : undefined,
    unfurl_links: false,
    unfurl_media: false,
  });
  return res.ts;
}

/** Strip the leading bot mention (<@U123> or <@U123|name>) and surrounding whitespace from message text. */
export function stripBotMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*:?\s*/, "").trim();
}

export function assertTokens(): { botToken: string; appToken: string } {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !botToken.startsWith("xoxb-"))
    throw new Error("SLACK_BOT_TOKEN must be set (starts with xoxb-)");
  if (!appToken || !appToken.startsWith("xapp-"))
    throw new Error("SLACK_APP_TOKEN must be set (starts with xapp-)");
  return { botToken, appToken };
}

export type SlackApp = App;
