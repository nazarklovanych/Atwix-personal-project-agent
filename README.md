# Personal Project Agent (PPA)

A Slack-mentionable, **read-only investigation agent** you deploy per project with a single Docker container.

> `@ppa hey, production emails are not sending — could you take a look?`

PPA reacts 👀, investigates using SSH access to your servers, git repos, and a read-only MySQL user, then posts **findings + next steps** back into the thread. Strictly investigation — no features, no PRs, no writes.

```
@ppa mention in a project channel
        │  Socket Mode WebSocket (no public URL, no TLS cert)
        ▼
Docker container (one per project)
 ├── Slack bot  👀 → investigate → reply in thread → ✅ / ❌ / ⏱
 └── Agent session (per Slack thread, follow-ups keep context)
      ├── git   — read-only deploy key, clones cached in ./work
      ├── ssh   — your servers: logs, service status
      └── mysql — dedicated read-only user (SELECT/SHOW only)
```

## Quickstart: add to a project in 4 files

1. **Build the image once** (any machine):
   ```bash
   git clone <this repo> && cd personal-project-agent
   docker build -t ppa:latest .
   ```
2. **Create the Slack app**: [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From an app manifest* → paste `slack-manifest.yml` → Install to Workspace. Copy the **Bot User OAuth Token** (`xoxb-…`). Then *Settings → Basic Information → App-Level Tokens* → generate a token with `connections:write` scope (`xapp-…`). Invite the bot to your project channel (`/invite @ppa`).
3. **In your project folder** copy from this repo:
   - `docker-compose.example.yml` → `docker-compose.yml` (fix `container_name`)
   - `ppa.example.yml` → `ppa.yml` (repos, servers, databases — see below)
   - `.env.example` → `.env` (Slack tokens + API key + DB passwords)
   - generate a dedicated SSH key: `ssh-keygen -t ed25519 -f ./ppa_key -N ""`
4. **Run**:
   ```bash
   docker compose up -d && docker compose logs -f
   ```

## Credential prep (the real safety boundary)

The agent runs shell commands, so **prompt rules are advisory — least-privilege credentials are the actual enforcement**:

- **Git**: add `ppa_key.pub` as a **read-only deploy key** in GitHub/GitLab repo settings. Pushes will be rejected.
- **MySQL** (on each project DB):
  ```sql
  CREATE USER 'ppa_ro'@'%' IDENTIFIED BY '<random>';
  GRANT SELECT ON myproject.* TO 'ppa_ro'@'%';
  ```
  Writes fail at the DB level even if attempted.
- **SQL write guard (built-in, tool layer)**: on top of prompt rules and DB grants, PPA wraps its bash tool with a hard guard — any command that would send `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, DDL (`DROP`/`ALTER`/`CREATE`/…), `GRANT`, `LOCK TABLES`, `LOAD DATA`, `KILL`, `SHUTDOWN`, `mysqladmin`, or `mysqldump` to MySQL/MariaDB is rejected *before execution* and logged as `[ppa:guard]`. Read queries (`SELECT`, `SHOW`, `EXPLAIN`, `DESCRIBE`, including `SELECT … FOR UPDATE` and multi-statement read scripts) pass through. This is defense-in-depth: guard (tool layer) → read-only DB user (server layer) → investigation-only prompt (advisory).
- **SSH to servers**: create a dedicated low-privilege user, add `ppa_key.pub` to its `authorized_keys`. Optional hardening — restrict to log-reading commands:
  ```
  # in /home/ppa/.ssh/authorized_keys (prefix the key line):
  command="/usr/local/bin/ppa-read-only",no-pty,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA...
  ```
  where `ppa-read-only` is a small wrapper allowing `tail`, `cat`, `grep`, `systemctl status`, `ps`, `df`, `free`, `ls`.
- **Workspace**: `/work` (the `./work` volume) holds disposable clones only — safe to `rm -rf`.

Secrets live only in `.env` and the mounted key — both gitignored here, keep it that way in your project folder too.

## Choosing the model (Anthropic, OpenAI, GLM, …)

Set `defaults.model` in `ppa.yml` (or `PPA_MODEL` in `.env`) as `provider/id`, and put the matching API key in `.env`. Built-in providers include:

| Provider | Env var | Example model |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-5` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-5` |
| **z.ai (GLM)** | `ZAI_API_KEY` | `zai/glm-4.7`, `zai/glm-5.3`, `zai/glm-5.3-flash` |

For GLM: get an API key at [z.ai](https://z.ai) (API → keys), add to `.env`:
```bash
ZAI_API_KEY=<your-key>
```
and set `model: zai/glm-4.7` in `ppa.yml` (or `PPA_MODEL=zai/glm-4.7`). To list every supported model/provider on your machine: `npx pi --list-models`.

## Usage

- Mention `@ppa` with a question → 👀 appears, investigation runs, result posted in-thread, reaction becomes ✅ (or ❌ on failure, ⏱ on timeout).
- **Follow-ups in the same thread continue the same session** — context is retained for ~60 min of idleness.
- For long investigations the agent posts 📌 interim updates itself.
- Timeout is `defaults.timeout_minutes` in `ppa.yml` (default 8) — on timeout you get partial findings.

## Multiple projects

One Slack app (one bot token pair) can serve several project containers: set `slack_channel_ids` in each project's `ppa.yml` so each instance only answers in its own channel. No cross-talk.

## Local development

```bash
npm install
PPA_CONFIG=./ppa.local.yml npm run dev
```

Environment variables: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `PPA_CONFIG` (path to ppa.yml, default `/app/ppa.yml`), `PPA_MODEL` (override model), `PPA_WORKSPACE` (default `/work`), `PPA_AGENT_DIR`.

## Reaching internal DBs/servers

If the DB or servers aren't reachable from the container's default network, see the commented options at the bottom of `docker-compose.example.yml` (`network_mode: host`, `extra_hosts`, or a VPN sidecar).

## What it will refuse to do

No writes anywhere: no `INSERT/UPDATE/DELETE/DDL`, no file modifications, no `git commit/push`, no service restarts. If you ask for something destructive, PPA refuses and suggests what it *can* check instead.

## Troubleshooting

- **"blocked by the permission system / requires approval"** — the SDK session inherited your interactive pi setup (`~/.pi/agent`), e.g. the `pi-permission-system` extension whose approvals can't be granted from Slack. PPA now uses its own isolated agent dir (`~/.pi/agent-ppa`, or `PPA_AGENT_DIR`) with a clean `settings.json`, so this should not happen. Auth comes from env vars (`ZAI_API_KEY` etc.), not your interactive logins.
- **Model auth error** — set the matching key env var in `.env`; the bot replies with a specific error naming the provider.
- **Not responding to mentions** — check `app_mention` event subscription, Socket Mode enabled, bot invited to the channel, and `slack_channel_ids` in ppa.yml matching the channel you're posting in.
