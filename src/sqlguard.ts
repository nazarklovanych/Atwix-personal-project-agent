/**
 * Hard SQL write guard: rejects any bash command that would send a write
 * statement to MySQL/MariaDB. This is enforcement at the tool layer —
 * independent of the system prompt (which is advisory) and of the DB user's
 * grants (which are the last line of defense).
 */

// Write/dangerous SQL statement patterns (applied to mysql-containing commands only).
const WRITE_SQL_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\binsert\s+into\b/i, what: "INSERT" },
  { re: /\breplace\s+into\b/i, what: "REPLACE" },
  { re: /\bupdate\s+\S+\s+set\b/i, what: "UPDATE" },
  { re: /\bdelete\s+from\b/i, what: "DELETE" },
  { re: /\bdrop\s+(database|table|index|view|schema|procedure|function|trigger|user)\b/i, what: "DROP" },
  { re: /\balter\s+(table|database|user|view)\b/i, what: "ALTER" },
  { re: /\btruncate\b/i, what: "TRUNCATE" },
  { re: /\bcreate\s+(table|database|index|view|schema|procedure|function|trigger|user)\b/i, what: "CREATE" },
  { re: /\bgrant\s+\w/i, what: "GRANT" },
  { re: /\brevoke\s+\w/i, what: "REVOKE" },
  { re: /\brename\s+(table|user)\b/i, what: "RENAME" },
  { re: /\block\s+tables\b/i, what: "LOCK TABLES" },
  { re: /\bload\s+data\b/i, what: "LOAD DATA" },
  { re: /\bset\s+(global|session)\b/i, what: "SET GLOBAL/SESSION" },
  { re: /\bcall\s+\w+\s*\(/i, what: "CALL" },
  { re: /\bshutdown\b/i, what: "SHUTDOWN" },
  { re: /\bkill\s+\d/i, what: "KILL" },
];

const MYSQL_CLIENT_RE = /\b(mysql|mysqladmin|mariadb|mariadb-admin|mysqldump)\b/;

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function checkCommand(command: string): GuardResult {
  if (!MYSQL_CLIENT_RE.test(command)) return { ok: true };

  if (/\bmysqladmin\b|\bmariadb-admin\b/.test(command)) {
    return { ok: false, reason: "mysqladmin is not allowed (admin operations are out of scope)" };
  }
  if (/\bmysqldump\b/.test(command)) {
    return { ok: false, reason: "mysqldump is not allowed (bulk data export is out of scope)" };
  }

  for (const { re, what } of WRITE_SQL_PATTERNS) {
    if (re.test(command)) {
      return {
        ok: false,
        reason:
          `blocked ${what} statement — database access is strictly read-only ` +
          `(SELECT / SHOW / EXPLAIN / DESCRIBE only). This protection cannot be overridden; suggest the write as a next step for a human instead.`,
      };
    }
  }
  return { ok: true };
}
