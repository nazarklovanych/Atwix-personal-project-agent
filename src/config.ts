import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export interface RepoConfig {
  name: string;
  url: string;
  /** Extra context for the agent, e.g. "Laravel API, mail queue lives in app/Jobs" */
  notes?: string;
}

export interface ServerConfig {
  name: string;
  host: string;
  user: string;
  port?: number;
  /** Where interesting logs live, shown to the agent up-front */
  log_paths?: string[];
  notes?: string;
}

export interface DatabaseConfig {
  name: string;
  host: string;
  port?: number;
  user: string;
  /** Name of the env var holding the password — NEVER the password itself */
  password_env: string;
  notes?: string;
}

export interface ProjectConfig {
  name: string;
  /** Restrict the agent to these Slack channel IDs; empty = respond anywhere it's mentioned */
  slack_channel_ids?: string[];
  repos: RepoConfig[];
  servers: ServerConfig[];
  databases: DatabaseConfig[];
  defaults: {
    timeout_minutes: number;
    model?: string;
  };
  /** Free-form project context injected into the system prompt */
  notes?: string;
}

const DEFAULTS = { timeout_minutes: 8 };

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(`ppa.yml: ${msg}`);
}

function asString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(`${path} must be a non-empty string`);
  return v.trim();
}

export function loadConfig(path: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`failed to parse ${path}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) fail("root must be a mapping");

  const r = raw as Record<string, unknown>;

  const name = asString(r.name, "name");

  const repos = (Array.isArray(r.repos) ? r.repos : fail("repos must be a list")).map(
    (item, i) => {
      if (typeof item !== "object" || item === null) fail(`repos[${i}] must be a mapping`);
      const x = item as Record<string, unknown>;
      const repo: RepoConfig = {
        name: asString(x.name, `repos[${i}].name`),
        url: asString(x.url, `repos[${i}].url`),
      };
      if (typeof x.notes === "string") repo.notes = x.notes;
      return repo;
    },
  );

  const servers = (Array.isArray(r.servers) ? r.servers : fail("servers must be a list")).map(
    (item, i) => {
      if (typeof item !== "object" || item === null) fail(`servers[${i}] must be a mapping`);
      const x = item as Record<string, unknown>;
      const server: ServerConfig = {
        name: asString(x.name, `servers[${i}].name`),
        host: asString(x.host, `servers[${i}].host`),
        user: asString(x.user, `servers[${i}].user`),
      };
      if (typeof x.port === "number") server.port = x.port;
      if (Array.isArray(x.log_paths))
        server.log_paths = x.log_paths.map((p, j) => asString(p, `servers[${i}].log_paths[${j}]`));
      if (typeof x.notes === "string") server.notes = x.notes;
      return server;
    },
  );

  const databases = (Array.isArray(r.databases) ? r.databases : fail("databases must be a list")).map(
    (item, i) => {
      if (typeof item !== "object" || item === null) fail(`databases[${i}] must be a mapping`);
      const x = item as Record<string, unknown>;
      const db: DatabaseConfig = {
        name: asString(x.name, `databases[${i}].name`),
        host: asString(x.host, `databases[${i}].host`),
        user: asString(x.user, `databases[${i}].user`),
        password_env: asString(x.password_env, `databases[${i}].password_env`),
      };
      if (typeof x.port === "number") db.port = x.port;
      if (typeof x.notes === "string") db.notes = x.notes;
      return db;
    },
  );

  let defaults: { timeout_minutes: number; model?: string } = { ...DEFAULTS };
  if (typeof r.defaults === "object" && r.defaults !== null) {
    const d = r.defaults as Record<string, unknown>;
    if (typeof d.timeout_minutes === "number" && d.timeout_minutes > 0)
      defaults.timeout_minutes = d.timeout_minutes;
    if (typeof d.model === "string") defaults.model = d.model;
  }

  const config: ProjectConfig = { name, repos, servers, databases, defaults };
  if (Array.isArray(r.slack_channel_ids))
    config.slack_channel_ids = r.slack_channel_ids.map((c, i) =>
      asString(c, `slack_channel_ids[${i}]`),
    );
  if (typeof r.notes === "string") config.notes = r.notes;

  return config;
}

/**
 * Resolve DB password env vars at startup so misconfiguration fails fast
 * (before the first mention), not mid-investigation.
 */
export function validateDatabaseSecrets(config: ProjectConfig): void {
  const missing = config.databases
    .filter((db) => !process.env[db.password_env])
    .map((db) => `${db.name}: env var ${db.password_env} is not set`);
  if (missing.length > 0) {
    throw new ConfigError(`missing database password env vars:\n  ${missing.join("\n  ")}`);
  }
}
