# Personal Project Agent — Slack-mentionable read-only investigation agent per project (Docker)

> Task: `personal-project-agent`
> Created: 2026-09-07T18:49:13.554Z
> Status: draft

## Overview

Personal Project Agent (PPA): a Slack-mentionable, read-only investigation agent you can deploy per project with a single Docker container. You @ppa in a project channel ("production emails are not sending, could you take a look?"), it reacts 👀, investigates using SSH access to your servers, git repos, and a read-only MySQL user, then posts findings + next steps back into the thread. Scope is strictly investigation — no features, no PRs, no writes.

## Goals

- Mention @ppa in a project Slack channel with an issue description → bot reacts 👀, investigates, posts findings + next steps in the same thread
- Agent has read-only access to: project git repos (SSH), production servers via SSH (logs, service status), and MySQL (SELECT/SHOW only)
- Investigation-only scope: no PRs, no code changes, no writes to production data, no service restarts
- One-command per-project setup via Docker (`docker compose up -d`)
- Follow-up questions in the same Slack thread continue the same investigation session (context retained)
- Long investigations post interim progress updates and respect a hard timeout

## Context / Findings

- Working directory `/home/nazar/Projects/personal-project-agent` is empty — greenfield project, no existing code or constraints.
- pi SDK (`@earendil-works/pi-coding-agent`) is available in this environment and is an ideal agent runtime: `createAgentSession()` supports custom tools (`defineTool`), tool allowlists (e.g. `["read", "bash", "grep", "find", "ls"]` with no `edit`/`write`), in-memory sessions, system prompt overrides via `DefaultResourceLoader`, and API-key auth via env (`ANTHROPIC_API_KEY`) — no login flow needed inside Docker.
- Slack research (docs.slack.dev): Bolt for JavaScript with **Socket Mode** (`socketMode: true` + app-level token `xapp-…`) is the recommended simple path — WebSocket outbound connection, **no public URL/TLS needed**, perfect for a Docker container on a home box or any VM. Required bot scopes: `app_mentions:read`, `chat:write`, `reactions:write`; app-level token scope: `connections:write`. The `app_mention` event fires when the bot is mentioned.
- Slack reaction APIs needed: `reactions.add` (👀 on start), `reactions.remove`/`reactions.add` (✅/❌ on completion); replies via `chat.postMessage` with `thread_ts`. All stable, standard Bolt/WebClient calls.
- pi SDK events (`agent_start`, `tool_execution_start`, `agent_end`, `message_end`) let the host service observe progress, implement timeouts, and extract the final assistant text to post back to Slack.
- Follow-up continuity: sessions can be keyed by Slack `thread_ts` in an in-process `Map` (with idle TTL eviction); `session.prompt()` with in-memory `SessionManager` per investigation keeps it simple.
- Required container tooling: Node 22 base image + `git`, `openssh-client`, `default-mysql-client` via apt — everything the bash tool needs to exercise SSH/git/mysql.

## Approach

A single Node.js/TypeScript service that runs both the Slack bot (Bolt + Socket Mode) and the agent runtime (pi SDK). Per project, you drop in a `docker-compose.yml` + `ppa.yml` (repos, servers, DBs, notes) + `.env` (tokens/API key) and run `docker compose up -d`. Each Slack thread maps to one in-memory agent session with tools: `read`, `bash`, `grep`, `find`, `ls` (no edit/write) plus a custom `slack_post_update` tool the agent uses to post interim findings into the thread. The bash tool gives it `git`, `ssh`, and `mysql` CLI access; safety comes from least-privilege credentials (read-only deploy key, read-only MySQL user, optionally SSH forced-command wrapper) plus a strict investigation-only system prompt — not from sandboxing the shell.

## Implementation Steps

1. **Scaffold repo**: `package.json` (type: module, TypeScript, deps: `@slack/bolt`, `@earendil-works/pi-coding-agent`, `js-yaml`; dev: `typescript`, `tsx`, `@types/*`), `tsconfig.json`, `.gitignore`.
2. **Project config loader (`src/config.ts`)**: parse `ppa.yml` — `name`, `repos[] (name, url)`, `servers[] (name, host, user, notes, log_paths)`, `databases[] (name, host, port, user, password_env, notes)`, `defaults (timeout_minutes, model)`. Validate required fields; resolve DB passwords from env vars named in `password_env` (never store secrets in yml).
3. **Slack layer (`src/index.ts` + `src/slack.ts`)**: Bolt `App` with `socketMode: true`, `appToken` (xapp-) and `token` (xoxb-). Listen for `app_mention`. On mention: `reactions.add` 👀 → strip bot mention from text → hand off to agent runner → post final result via `chat.postMessage` with `thread_ts` → `reactions.remove` 👀 + `reactions.add` ✅ (or ❌ with error summary). Ignore bot's own messages; only respond in configured channel(s) if restricted in ppa.yml.
4. **Agent runner (`src/agent.ts`)**: per `thread_ts`, create (or reuse, TTL ~60 min idle) an in-memory pi session via `createAgentSession({ model from env/config, tools: ["read","bash","grep","find","ls"], customTools: [slackPostUpdate], sessionManager: SessionManager.inMemory(), resourceLoader with systemPromptOverride })`. Custom tool `slack_post_update(text)` posts an interim message to the thread — the agent uses it for step-by-step findings on long investigations. Run `session.prompt(userText)`; collect final assistant text from `agent_end`/`message_end` events. Wrap in `Promise.race` with configurable timeout (default 8 min): on timeout, `session.abort()`, post collected interim results + "timed out" notice. On error: ❌ + error message.
5. **System prompt builder**: embed ppa.yml context (repo paths under `/work`, servers, DB connection commands with the ready-to-use `mysql -h … -u ppa_ro -p$MAIN_DB_PASSWORD` pattern, log locations, project notes). Hard rules in prompt: investigation only; read-only (`SELECT`/`SHOW`/`EXPLAIN` only — never INSERT/UPDATE/DELETE/DDL; never modify files; never restart services; never push/commit); first clone/fetch repos on demand (`git clone` into `/work`, `git fetch` + `git log` for recency); keep answers concise: **Findings → Root cause (if known) → Suggested next steps**; use `slack_post_update` for intermediate discoveries if investigation will take a while.
6. **Dockerfile**: `node:22-slim` + `apt-get install git openssh-client default-mysql-client`; install npm deps, build TS, run compiled `src/index.ts` via node. Non-root `ppa` user; `WORKDIR /app`, workspace `/work`.
7. **Per-project deployment kit**: `docker-compose.example.yml` (single `ppa` service; mounts `./ppa.yml:/app/ppa.yml:ro`, `./ppa_key:/home/ppa/.ssh/id_ed25519:ro`, `./work:/work`; `env_file: .env`; `restart: unless-stopped`; optional `network_mode` note for reaching internal DBs); `ppa.example.yml` with comments; `.env.example` (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`, DB password vars); `slack-manifest.yml` (scopes `app_mentions:read`, `chat:write`, `reactions:write`; Socket Mode on; `connections:write` app token) for one-paste Slack app setup.
8. **README.md**: architecture diagram, Slack app setup (manifest paste → install → invite bot to channel), credential prep per project (GitHub/GitLab read-only deploy key, MySQL `CREATE USER 'ppa_ro'… GRANT SELECT ON db.*`, SSH key on servers — optionally restricted via `authorized_keys` forced command or a dedicated low-priv user), and "add to a project in 3 files" quickstart.
9. **Local test**: run with `tsx` against a real Slack workspace test channel + a real repo/DB; verify 👀→✅ flow, thread replies, follow-up context reuse, timeout path (short timeout), refusal of destructive requests.

## Files to Modify

All new files in `/home/nazar/Projects/personal-project-agent/`:
`package.json`, `tsconfig.json`, `src/index.ts`, `src/config.ts`, `src/agent.ts`, `src/slack.ts`, `slack-manifest.yml`, `ppa.example.yml`, `Dockerfile`, `.dockerignore`, `.gitignore`, `docker-compose.example.yml`, `.env.example`, `README.md`

## Risks / Edge Cases

- **Bash tool is powerful — prompt constraints are not a hard boundary.** The agent could technically run `rm` or an UPDATE via bash. Mitigations: real safety comes from least-privilege credentials (read-only MySQL user blocks writes; read-only deploy key blocks pushes; SSH access to a dedicated low-privilege user, optionally with `authorized_keys` forced-command wrappers). Document optional hardening (read-only `:ro` mounts, restricted SSH). Workspace `/work` is disposable clones only.
- **Long investigations**: hard timeout (default 8 min) + agent-driven interim `slack_post_update` posts keep the thread informed; on timeout post partial findings rather than nothing.
- **First-run latency**: initial `git clone` of repos can be slow; mitigate with persistent `/work` volume across restarts and `git fetch` refresh instead of re-clone.
- **Secrets**: DB passwords and tokens live only in `.env`/env vars (never in ppa.yml); SSH key mounted read-only; `.env` and keys gitignored; warn against committing them.
- **Slack rate limits / long messages**: chunk or trim long output to Slack's 40k block limit; use plain thread text with light formatting.
- **Cost control**: one session per thread, idle TTL eviction; consider a simple max-concurrent-investigations semaphore (1–2) to cap spend; note model choice per project in ppa.yml.
- **Docker networking**: reaching internal DBs/servers may need host networking or VPN sidecar — document `network_mode`/extra_hosts options.
- **Socket Mode reconnects**: Bolt handles WebSocket reconnects; add `restart: unless-stopped` and basic process-level error logging.
- **Multiple projects**: one Slack app (one bot user) can serve many compose instances, but replies route to whatever channel mentioned it — simplest model is one app token shared, each instance only responds in its configured channel(s) to avoid cross-talk; document this.

## Testing

- Local dev run (`npx tsx src/index.ts`) against a scratch Slack channel: mention @ppa with a planted issue (e.g. fake log entry via ssh + a row in a test DB) and verify it finds it.
- Reaction lifecycle: 👀 appears immediately, ends ✅ on success / ❌ on error / ⏱ notice on timeout.
- Follow-up in same thread: verify second question has context of first investigation.
- Destructive-request guardrail: ask agent to "delete all users" / "restart nginx" → verify refusal in reply and that read-only DB user would have rejected it anyway.
- Docker: `docker compose up -d` from the example kit, repeat the end-to-end test from inside the container; restart container → Socket Mode reconnects, `/work` clones persist.
- Repo hygiene: `git status` clean of secrets (`.env`, `ppa_key`, `work/` ignored).

## Acceptance Criteria

- `docker compose up -d` in a project folder (with `ppa.yml`, `.env`, SSH key) brings up a working @ppa bot that connects via Socket Mode.
- Mentioning @ppa in the configured channel adds 👀, and the investigation result (or error/timeout notice) is posted in the same thread; reaction ends as ✅/❌.
- The agent can inspect project repos (SSH read-only), tail logs on configured servers, and run SELECT/SHOW queries against configured databases.
- Agent sessions expose only `read/bash/grep/find/ls` + `slack_post_update` — no `edit`/`write` tools; workspace contains clones only.
- Follow-up mentions in the same thread continue the previous investigation context.
- Guardrail test: asking the agent to delete/modify data is refused by prompt, and even if attempted, the read-only DB user and read-only deploy key make writes fail.
- Timeout (default 8 min) posts partial findings instead of hanging silently; interim updates appear for slow investigations.
