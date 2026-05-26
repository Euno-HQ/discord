/**
 * Metrics validation cross-checks per `notes/2026-05-12_2_metrics-spec.md`
 * (the "Validation script" section).
 *
 * Each check emits a row `(id, check, actual, status: OK | FLAG | INFO)`.
 * Markdown table goes to stdout. Exit 0 if no FLAGs, exit 1 otherwise.
 *
 * Read-only. Refuses to run without DATABASE_URL.
 */

import { resolve } from "path";
import SQLite from "better-sqlite3";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set.");
  process.exit(1);
}

const GUILD_ID = "102860784329052160";
const BOT_USER_ID = "984212151608705054";
const DISCORD_EPOCH_MS = 1420070400000;

const dbPath = resolve(DATABASE_URL);
const db = new SQLite(dbPath, { readonly: true });

type Status = "OK" | "FLAG" | "INFO";
interface Row {
  id: string;
  check: string;
  actual: string;
  status: Status;
}

const rows: Row[] = [];
const add = (id: string, check: string, actual: string, status: Status) =>
  rows.push({ id, check, actual, status });

// CS1 — spam back-fill rate ≤ 5% -----------------------------------------
{
  const r = db
    .prepare<[string], { total: number; backfilled: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN extra LIKE 'Back-filled%' THEN 1 ELSE 0 END) AS backfilled
         FROM reported_messages
        WHERE guild_id = ? AND reason = 'spam'`,
    )
    .get(GUILD_ID)!;
  const rate = r.total === 0 ? 0 : (r.backfilled * 100) / r.total;
  add(
    "CS1",
    "spam back-fill rate ≤ 5%",
    `${rate.toFixed(2)}% (${r.backfilled}/${r.total})`,
    rate <= 5 ? "OK" : "FLAG",
  );
}

// CS2 — resolved_at count == resolution count ---------------------------
{
  const r = db
    .prepare<[string], { a: number; b: number }>(
      `SELECT SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS a,
              SUM(CASE WHEN resolution IS NOT NULL THEN 1 ELSE 0 END) AS b
         FROM escalations
        WHERE guild_id = ?`,
    )
    .get(GUILD_ID)!;
  const a = r.a ?? 0;
  const b = r.b ?? 0;
  add(
    "CS2",
    "resolved_at == resolution count",
    `${a} == ${b}`,
    a === b ? "OK" : "FLAG",
  );
}

// CS3 — voter cardinality sanity ----------------------------------------
{
  const r = db
    .prepare<[string], { distinct_voters: number; records: number }>(
      `SELECT COUNT(DISTINCT er.voter_id) AS distinct_voters,
              COUNT(*) AS records
         FROM escalation_records er
         JOIN escalations e ON e.id = er.escalation_id
        WHERE e.guild_id = ?`,
    )
    .get(GUILD_ID)!;
  const ok = r.records <= 5 || r.distinct_voters < r.records;
  add(
    "CS3",
    "distinct voters < records (if records > 5)",
    `${r.distinct_voters} / ${r.records}`,
    ok ? "OK" : "FLAG",
  );
}

// CS4 — anonymity contract ----------------------------------------------
{
  const r = db
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM reported_messages
        WHERE guild_id = ? AND reason='anonReport' AND staff_id IS NOT NULL`,
    )
    .get(GUILD_ID)!;
  add(
    "CS4",
    "anonReport never has staff_id",
    `${r.n} rows`,
    r.n === 0 ? "OK" : "FLAG",
  );
}

// CS5 — self-action leakage ---------------------------------------------
{
  const r = db
    .prepare<[string, string, string], { leak_count: number }>(
      `WITH eligible_reports AS (
         SELECT id, reported_user_id, reason, created_at
           FROM reported_messages
          WHERE guild_id = ?
            AND reason IN ('anonReport','track','spam','modResolution','automod')
            AND (extra IS NULL OR extra NOT LIKE 'Back-filled%')
            AND created_at >= '2026-02-20'
       )
       SELECT COUNT(*) AS leak_count
         FROM eligible_reports er
        WHERE EXISTS (
          SELECT 1 FROM mod_actions ma
           WHERE ma.guild_id = ?
             AND ma.user_id = ?
             AND ma.user_id = er.reported_user_id
             AND julianday(ma.created_at) BETWEEN julianday(er.created_at)
               AND julianday(er.created_at) + 1
        )`,
    )
    .get(GUILD_ID, GUILD_ID, BOT_USER_ID)!;
  add(
    "CS5",
    "matched mod_actions don't target bot",
    `${r.leak_count} pairs`,
    r.leak_count === 0 ? "OK" : "FLAG",
  );
}

// CS6 — bot exclusion holds ---------------------------------------------
const countBot = (sql: string) =>
  db.prepare<[string, string], { n: number }>(sql).get(GUILD_ID, BOT_USER_ID)!
    .n;

{
  const a = countBot(
    `SELECT COUNT(*) AS n FROM mod_actions WHERE guild_id=? AND executor_id=?`,
  );
  const b = countBot(
    `SELECT COUNT(*) AS n FROM reported_messages
      WHERE guild_id=? AND staff_id=?
        AND reason IN ('anonReport','track','spam','modResolution','automod')`,
  );
  const c = countBot(
    `SELECT COUNT(*) AS n
       FROM escalation_records er
       JOIN escalations e ON e.id=er.escalation_id
      WHERE e.guild_id=? AND er.voter_id=?`,
  );
  add(
    "CS6a",
    "bot not in mod_actions.executor_id",
    `${a} rows`,
    a === 0 ? "OK" : "FLAG",
  );
  add(
    "CS6b",
    "bot in reported_messages.staff_id (informational)",
    `${b} rows`,
    "INFO",
  );
  add(
    "CS6c",
    "bot not in escalation voters",
    `${c} rows`,
    c === 0 ? "OK" : "FLAG",
  );
}

// CS7 — message_stats epoch sanity --------------------------------------
{
  const r = db
    .prepare<
      [string],
      { min_sent_at: number | null; max_sent_at: number | null }
    >(
      `SELECT MIN(sent_at) AS min_sent_at, MAX(sent_at) AS max_sent_at
         FROM message_stats WHERE guild_id = ?`,
    )
    .get(GUILD_ID)!;
  const min = r.min_sent_at ?? 0;
  const max = r.max_sent_at ?? 0;
  const ok =
    min >= DISCORD_EPOCH_MS &&
    max > 0 &&
    max <= Date.now() + 86_400_000 &&
    min <= max;
  const minIso = min > 0 ? new Date(min).toISOString() : "(empty)";
  const maxIso = max > 0 ? new Date(max).toISOString() : "(empty)";
  add(
    "CS7",
    "sent_at in [2015, now+1d], min ≤ max",
    `MIN=${minIso} MAX=${maxIso}`,
    ok ? "OK" : "FLAG",
  );
}

// SCHEMA — migration count 29 or 30 -------------------------------------
{
  const n = db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM kysely_migration`)
    .get()!.n;
  add(
    "SCHEMA",
    "kysely_migration count in {29,30}",
    `${n}`,
    n === 29 || n === 30 ? "OK" : "FLAG",
  );
}

// CORRUPT — corrupt-row count stable ------------------------------------
{
  const n = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM reported_messages
        WHERE reason NOT IN ('anonReport','track','spam','modResolution','automod')`,
    )
    .get()!.n;
  const status: Status = n === 82 ? "OK" : n > 82 ? "FLAG" : "INFO";
  add("CORRUPT", "corrupt reported_messages == 82", `${n}`, status);
}

// DEL-LOG — observation of fix-migration state --------------------------
{
  const n = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM deletion_log_threads
        WHERE created_at = 'CURRENT_TIMESTAMP'`,
    )
    .get()!.n;
  add("DEL-LOG", "deletion_log_threads CURRENT_TIMESTAMP rows", `${n}`, "INFO");
}

// Output -----------------------------------------------------------------
db.close();

const generatedAt = new Date().toISOString();
const ok = rows.filter((r) => r.status === "OK").length;
const flag = rows.filter((r) => r.status === "FLAG").length;
const info = rows.filter((r) => r.status === "INFO").length;
const exitCode = flag === 0 ? 0 : 1;

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
const tbody = rows
  .map(
    (r, i) =>
      `| ${i + 1} | ${esc(r.id)} | ${esc(r.check)} | ${esc(r.actual)} | ${r.status} |`,
  )
  .join("\n");

process.stdout.write(`# Metrics validation — ${generatedAt}
source: ${dbPath}

| # | id | check | actual | status |
|---|---|---|---|---|
${tbody}

summary: ${rows.length} checks — ${ok} OK, ${flag} FLAG, ${info} INFO (exit ${exitCode})
`);

process.exit(exitCode);
