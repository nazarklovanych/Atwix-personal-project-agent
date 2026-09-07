import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

export const EYES = "eyes";
export const CHECK = "white_check_mark";
export const CROSS = "x";
export const HOURGLASS = "hourglass_flowing_sand";

/** Max characters for a single Slack message body we are willing to post. */
const MAX_MSG_LEN = 35000;

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

/** Post a message into the same thread as ts. Returns the posted message ts. */
export async function postToThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string | undefined> {
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: trim(text),
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
