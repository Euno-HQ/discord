/**
 * Reactiflux case-study report (CS1–CS7).
 *
 * Implements the queries in `notes/2026-05-12_2_metrics-spec.md` against the
 * SQLite DB at DATABASE_URL (read-only). Emits a data-dense Markdown report
 * to stdout. No prose narration; the spec doc carries definitions/caveats.
 *
 * Usage:
 *   DATABASE_URL=./prod-mod-bot.sqlite3 \
 *     node --experimental-strip-types scripts/metrics-reactiflux-case-study.ts
 */

import { resolve } from "path";
import SQLite from "better-sqlite3";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set.");
  process.exit(1);
}

const GUILD_ID = "102860784329052160"; // Reactiflux
const BOT_USER_ID = "984212151608705054"; // Euno

const dbPath = resolve(DATABASE_URL);
const db = new SQLite(dbPath, { readonly: true });

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (num: number, den: number) =>
  den === 0 ? "0.0" : ((num * 100) / den).toFixed(1);

// CS1 ---------------------------------------------------------------------
const spamWindow = (daysClause: string) =>
  db
    .prepare<[string], { spam_events: number }>(
      `SELECT COUNT(*) AS spam_events
         FROM reported_messages
        WHERE guild_id = ?
          AND reason = 'spam'
          AND (extra IS NULL OR extra NOT LIKE 'Back-filled%')
          ${daysClause}`,
    )
    .get(GUILD_ID)!.spam_events;

const spam30 = spamWindow("AND created_at >= datetime('now', '-30 days')");
const spam90 = spamWindow("AND created_at >= datetime('now', '-90 days')");
const spamLife = spamWindow("");

// CS2 ---------------------------------------------------------------------
const escSummary = db
  .prepare<[string], { initiated: number; resolved: number }>(
    `SELECT COUNT(*) AS initiated,
            SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
       FROM escalations
      WHERE guild_id = ?`,
  )
  .get(GUILD_ID)!;

const escBuckets = db
  .prepare<
    [string],
    {
      bucket: string;
      n: number;
      avg_hours: number | null;
      min_hours: number | null;
      max_hours: number | null;
    }
  >(
    `SELECT
       CASE WHEN scheduled_for IS NULL OR scheduled_for=''
            THEN 'unscheduled' ELSE 'scheduled' END AS bucket,
       COUNT(*) AS n,
       ROUND(AVG((julianday(resolved_at) - julianday(created_at)) * 24), 1) AS avg_hours,
       ROUND(MIN((julianday(resolved_at) - julianday(created_at)) * 24), 1) AS min_hours,
       ROUND(MAX((julianday(resolved_at) - julianday(created_at)) * 24), 1) AS max_hours
     FROM escalations
     WHERE guild_id = ? AND resolved_at IS NOT NULL
     GROUP BY bucket`,
  )
  .all(GUILD_ID);

const escMix = db
  .prepare<[string], { resolution: string; n: number }>(
    `SELECT resolution, COUNT(*) AS n
       FROM escalations
      WHERE guild_id = ? AND resolution IS NOT NULL
      GROUP BY resolution
      ORDER BY n DESC`,
  )
  .all(GUILD_ID);

// CS3 ---------------------------------------------------------------------
const voterCount = db
  .prepare<[string, string], { n: number }>(
    `SELECT COUNT(DISTINCT er.voter_id) AS n
       FROM escalation_records er
       JOIN escalations e ON e.id = er.escalation_id
      WHERE e.guild_id = ? AND er.voter_id != ?`,
  )
  .get(GUILD_ID, BOT_USER_ID)!.n;

const activeModDenom = db
  .prepare<[string, string, string, string], { n: number }>(
    `SELECT COUNT(DISTINCT mod_id) AS n FROM (
       SELECT DISTINCT staff_id AS mod_id
         FROM reported_messages
        WHERE guild_id = ?
          AND staff_id IS NOT NULL
          AND staff_id != ?
          AND reason IN ('anonReport','track','spam','modResolution','automod')
          AND created_at BETWEEN '2025-12-04' AND '2026-02-21'
       UNION
       SELECT DISTINCT voter_id
         FROM escalation_records er
         JOIN escalations e ON e.id = er.escalation_id
        WHERE e.guild_id = ?
          AND er.voter_id != ?
     )`,
  )
  .get(GUILD_ID, BOT_USER_ID, GUILD_ID, BOT_USER_ID)!.n;

// CS4 ---------------------------------------------------------------------
const reportBreakdown = db
  .prepare<[string], { reason: string; source: string; n: number }>(
    `SELECT reason,
            CASE WHEN staff_id IS NULL THEN 'anonymous' ELSE 'staff' END AS source,
            COUNT(*) AS n
       FROM reported_messages
      WHERE guild_id = ?
        AND reason IN ('anonReport','track','spam','modResolution','automod')
      GROUP BY reason, source
      ORDER BY reason, source`,
  )
  .all(GUILD_ID);

// CS5 ---------------------------------------------------------------------
const conversion = db
  .prepare<
    [string, string],
    { reason: string; n_reports: number; resolved_within_24h: number }
  >(
    `WITH eligible_reports AS (
       SELECT id, reported_user_id, reason, created_at
         FROM reported_messages
        WHERE guild_id = ?
          AND reason IN ('anonReport','track','spam','modResolution','automod')
          AND (extra IS NULL OR extra NOT LIKE 'Back-filled%')
          AND created_at >= '2026-02-20'
     )
     SELECT reason,
            COUNT(*) AS n_reports,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM mod_actions ma
              WHERE ma.guild_id = ?
                AND ma.user_id = eligible_reports.reported_user_id
                AND julianday(ma.created_at) BETWEEN julianday(eligible_reports.created_at)
                  AND julianday(eligible_reports.created_at) + 1
            ) THEN 1 ELSE 0 END) AS resolved_within_24h
       FROM eligible_reports
      GROUP BY reason`,
  )
  .all(GUILD_ID, GUILD_ID);

// CS6 ---------------------------------------------------------------------
const activeMods = db
  .prepare<
    [string, string, string, string, string, string],
    { ym: string; active_mods: number }
  >(
    `WITH all_mod_activity AS (
       SELECT executor_id AS mod_id, strftime('%Y-%m', created_at) AS ym
         FROM mod_actions
        WHERE guild_id = ?
          AND executor_id IS NOT NULL
          AND executor_id != ?
       UNION ALL
       SELECT staff_id, strftime('%Y-%m', created_at)
         FROM reported_messages
        WHERE guild_id = ?
          AND staff_id IS NOT NULL
          AND staff_id != ?
          AND reason IN ('anonReport','track','spam','modResolution','automod')
       UNION ALL
       SELECT er.voter_id, strftime('%Y-%m', er.voted_at)
         FROM escalation_records er
         JOIN escalations e ON e.id = er.escalation_id
        WHERE e.guild_id = ?
          AND er.voter_id != ?
     )
     SELECT ym, COUNT(DISTINCT mod_id) AS active_mods
       FROM all_mod_activity
      WHERE ym IS NOT NULL
      GROUP BY ym ORDER BY ym`,
  )
  .all(GUILD_ID, BOT_USER_ID, GUILD_ID, BOT_USER_ID, GUILD_ID, BOT_USER_ID);

const currentYm = new Date().toISOString().slice(0, 7);
const peakRow = activeMods
  .filter((r) => r.ym !== currentYm)
  .reduce<{
    ym: string;
    active_mods: number;
  } | null>(
    (best, r) => (best === null || r.active_mods > best.active_mods ? r : best),
    null,
  );

// CS7 ---------------------------------------------------------------------
const messagesSince = (daysClause: string) =>
  db
    .prepare<
      [string],
      { messages: number }
    >(`SELECT COUNT(*) AS messages FROM message_stats WHERE guild_id = ? ${daysClause}`)
    .get(GUILD_ID)!.messages;

const msg30 = messagesSince(
  "AND sent_at >= (strftime('%s','now') - 30*86400) * 1000",
);
const msg90 = messagesSince(
  "AND sent_at >= (strftime('%s','now') - 90*86400) * 1000",
);
const msgLife = messagesSince("");

const topCategories = db
  .prepare<[string], { channel_category: string | null; messages: number }>(
    `SELECT channel_category, COUNT(*) AS messages
       FROM message_stats
      WHERE guild_id = ?
        AND sent_at >= (strftime('%s','now') - 30*86400) * 1000
      GROUP BY channel_category
      ORDER BY messages DESC LIMIT 5`,
  )
  .all(GUILD_ID);

db.close();

// Render ------------------------------------------------------------------
const generatedAt = new Date().toISOString();

const unscheduled = escBuckets.find((b) => b.bucket === "unscheduled");
const scheduled = escBuckets.find((b) => b.bucket === "scheduled");
const mixCells = escMix.map((r) => `${r.n} ${r.resolution}`).join(", ") || "—";

const reasons = ["anonReport", "track", "spam", "modResolution", "automod"];
const reportRows = reasons
  .map((reason) => {
    const staff =
      reportBreakdown.find((r) => r.reason === reason && r.source === "staff")
        ?.n ?? 0;
    const anon =
      reportBreakdown.find(
        (r) => r.reason === reason && r.source === "anonymous",
      )?.n ?? 0;
    if (staff === 0 && anon === 0) return null;
    return `| ${reason} | ${staff === 0 ? "—" : fmt(staff)} | ${anon === 0 ? "—" : fmt(anon)} |`;
  })
  .filter(Boolean)
  .join("\n");

const convTotal = conversion.reduce(
  (acc, c) => ({
    n_reports: acc.n_reports + c.n_reports,
    resolved_within_24h: acc.resolved_within_24h + c.resolved_within_24h,
  }),
  { n_reports: 0, resolved_within_24h: 0 },
);
const convRows = conversion
  .sort((a, b) => b.n_reports - a.n_reports)
  .map(
    (c) =>
      `| ${c.reason} | ${fmt(c.n_reports)} | ${fmt(c.resolved_within_24h)} | ${pct(c.resolved_within_24h, c.n_reports)}% |`,
  )
  .join("\n");

const activeModRows = activeMods
  .map(
    (r) =>
      `| ${r.ym}${r.ym === currentYm ? " (MTD)" : ""} | ${r.active_mods} |`,
  )
  .join("\n");

const categoryRows = topCategories
  .map(
    (c) =>
      `| ${c.channel_category ?? "(uncategorized)"} | ${fmt(c.messages)} |`,
  )
  .join("\n");

const escSchedLine = scheduled
  ? `scheduled (n=${scheduled.n}): ${scheduled.min_hours}–${scheduled.max_hours}h, avg ${scheduled.avg_hours}h`
  : "scheduled (n=0): —";
const escUnschedLine = unscheduled
  ? `unscheduled (n=${unscheduled.n}): ${unscheduled.min_hours}–${unscheduled.max_hours}h, avg ${unscheduled.avg_hours}h`
  : "unscheduled (n=0): —";

const md = `# Reactiflux case study — ${generatedAt}
source: ${dbPath}
guild: ${GUILD_ID}

## CS1 spam interruptions (interrupt_min = events × 2)
| window | events | interrupt_min |
|---|---|---|
| 30d | ${fmt(spam30)} | ${fmt(spam30 * 2)} |
| 90d | ${fmt(spam90)} | ${fmt(spam90 * 2)} |
| life | ${fmt(spamLife)} | — |
cohort_floor: 2025-07-26

## CS2 escalations
initiated: ${escSummary.initiated} | resolved: ${escSummary.resolved} (${pct(escSummary.resolved, escSummary.initiated)}%)
resolution mix: ${mixCells}
${escSchedLine}
${escUnschedLine}
cohort_floor: 2025-12-04

## CS3 escalation voter participation
distinct voters: ${voterCount}
active mods (denom): ${activeModDenom}
participation: ${pct(voterCount, activeModDenom)}%

## CS4 reports by reason × source
| reason | staff | anonymous |
|---|---|---|
${reportRows}

## CS5 reports → enforcement (24h, cohort_floor=2026-02-20)
| reason | n_reports | resolved_24h | pct |
|---|---|---|---|
${convRows}
| total | ${fmt(convTotal.n_reports)} | ${fmt(convTotal.resolved_within_24h)} | ${pct(convTotal.resolved_within_24h, convTotal.n_reports)}% |

## CS6 monthly active mods (bot excluded; active = mod_action ∪ track-report ∪ vote)
| ym | n |
|---|---|
${activeModRows}
peak: ${peakRow ? `${peakRow.active_mods} in ${peakRow.ym}` : "—"}

## CS7 message volume
| window | n |
|---|---|
| 30d | ${fmt(msg30)} |
| 90d | ${fmt(msg90)} |
| life | ${fmt(msgLife)} |

### top categories (30d)
| category | msgs_30d |
|---|---|
${categoryRows}
`;

process.stdout.write(md);
