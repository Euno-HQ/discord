/**
 * Funnel snapshot metrics (F1–F6) per
 * `notes/2026-05-12_2_metrics-spec.md`.
 *
 * Reads the SQLite database at DATABASE_URL (read-only). Emits a single
 * JSON object to stdout — pure data, no per-metric narration. Definitions,
 * gates, and caveats live in the spec doc.
 *
 * Usage:
 *   DATABASE_URL=./prod-mod-bot.sqlite3 \
 *     node --experimental-strip-types scripts/metrics-funnel-snapshot.ts
 *
 *   GTM_LAUNCH_DATE=2026-06-01 (optional) — adds a `since_gtm` view to
 *   every install-anchored metric (F1–F5) using the given date as cohort
 *   floor.
 */

import path from "path";
import SQLite from "better-sqlite3";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL || DATABASE_URL.trim() === "") {
  console.error("ERROR: DATABASE_URL is required.");
  process.exit(1);
}

const GTM_LAUNCH_DATE = process.env.GTM_LAUNCH_DATE?.trim();
if (GTM_LAUNCH_DATE && !/^\d{4}-\d{2}-\d{2}/.test(GTM_LAUNCH_DATE)) {
  console.error(
    `ERROR: GTM_LAUNCH_DATE must be ISO date (YYYY-MM-DD). Got: ${GTM_LAUNCH_DATE}`,
  );
  process.exit(1);
}

const FLOOR_INSTALLS = "2026-02-18";
const FLOOR_INSTALLS_STRICT = "2026-02-20";

const db = new SQLite(DATABASE_URL, { readonly: true, fileMustExist: true });

// F1 ---------------------------------------------------------------------
const f1 = (floor: string) =>
  db
    .prepare<[string], { week: string; installs: number }>(
      `SELECT strftime('%Y-W%W', created_at) AS week,
              COUNT(*) AS installs
         FROM guild_subscriptions
        WHERE created_at >= ?
        GROUP BY week
        ORDER BY week`,
    )
    .all(floor);

// F2 ---------------------------------------------------------------------
const f2 = (floor: string) =>
  db
    .prepare<
      [string],
      {
        install_month: string;
        cohort_size: number;
        converted: number;
        pct: number;
      }
    >(
      `WITH cohorts AS (
         SELECT strftime('%Y-%m', created_at) AS install_month,
                product_tier,
                julianday('now') - julianday(created_at) AS days_since_install
           FROM guild_subscriptions
          WHERE created_at >= ?
       )
       SELECT install_month,
              COUNT(*) AS cohort_size,
              SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) AS converted,
              ROUND(100.0 * SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct
         FROM cohorts
        WHERE days_since_install >= 90
        GROUP BY install_month
       HAVING cohort_size >= 5
        ORDER BY install_month`,
    )
    .all(floor);

// F3 ---------------------------------------------------------------------
const f3 = (floor: string) =>
  db
    .prepare<
      [string],
      {
        sample_n: number;
        min_days: number | null;
        avg_days: number | null;
        max_days: number | null;
      }
    >(
      `WITH first_actions AS (
         SELECT guild_id, MIN(created_at) AS first_action_at
           FROM mod_actions
          GROUP BY guild_id
       )
       SELECT COUNT(*) AS sample_n,
              ROUND(MIN(julianday(fa.first_action_at) - julianday(gs.created_at)), 2) AS min_days,
              ROUND(AVG(julianday(fa.first_action_at) - julianday(gs.created_at)), 2) AS avg_days,
              ROUND(MAX(julianday(fa.first_action_at) - julianday(gs.created_at)), 2) AS max_days
         FROM guild_subscriptions gs
         JOIN first_actions fa ON fa.guild_id = gs.guild_id
        WHERE gs.created_at >= ?`,
    )
    .get(floor)!;

// F4 ---------------------------------------------------------------------
const f4Windows = (floor: string) =>
  db
    .prepare<
      [string],
      {
        window: string;
        eligible: number;
        modLog: number;
        moderator: number;
        deletionLog: number;
        honeypot: number;
        reactji: number;
        membergate: number;
      }
    >(
      `WITH cohort AS (
         SELECT gs.guild_id, gs.created_at AS installed_at,
                julianday('now') - julianday(gs.created_at) AS days_since_install
           FROM guild_subscriptions gs
          WHERE gs.created_at >= ?
       ),
       feats AS (
         SELECT c.*,
           (SELECT JSON_EXTRACT(g.settings, '$.modLog') FROM guilds g WHERE g.id = c.guild_id) IS NOT NULL AS has_modLog,
           (SELECT JSON_EXTRACT(g.settings, '$.moderator') FROM guilds g WHERE g.id = c.guild_id) IS NOT NULL AS has_moderator,
           (SELECT JSON_EXTRACT(g.settings, '$.deletionLog') FROM guilds g WHERE g.id = c.guild_id) IS NOT NULL AS has_deletionLog,
           EXISTS(SELECT 1 FROM honeypot_config hc WHERE hc.guild_id = c.guild_id) AS has_honeypot,
           EXISTS(SELECT 1 FROM reactji_channeler_config rcc WHERE rcc.guild_id = c.guild_id) AS has_reactji,
           EXISTS(SELECT 1 FROM application_config ac WHERE ac.guild_id = c.guild_id) AS has_membergate
         FROM cohort c
       )
       SELECT 'd7' AS window,
              COALESCE(SUM(CASE WHEN days_since_install >= 7 THEN 1 ELSE 0 END), 0) AS eligible,
              COALESCE(SUM(CASE WHEN days_since_install >= 7 AND has_modLog THEN 1 ELSE 0 END), 0) AS modLog,
              COALESCE(SUM(CASE WHEN days_since_install >= 7 AND has_moderator THEN 1 ELSE 0 END), 0) AS moderator,
              COALESCE(SUM(CASE WHEN days_since_install >= 7 AND has_deletionLog THEN 1 ELSE 0 END), 0) AS deletionLog,
              COALESCE(SUM(CASE WHEN days_since_install >= 7 AND has_honeypot THEN 1 ELSE 0 END), 0) AS honeypot,
              COALESCE(SUM(CASE WHEN days_since_install >= 7 AND has_reactji THEN 1 ELSE 0 END), 0) AS reactji,
              COALESCE(SUM(CASE WHEN days_since_install >= 7 AND has_membergate THEN 1 ELSE 0 END), 0) AS membergate
         FROM feats
       UNION ALL
       SELECT 'd30',
              COALESCE(SUM(CASE WHEN days_since_install >= 30 THEN 1 ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN days_since_install >= 30 AND has_modLog THEN 1 ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN days_since_install >= 30 AND has_moderator THEN 1 ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN days_since_install >= 30 AND has_deletionLog THEN 1 ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN days_since_install >= 30 AND has_honeypot THEN 1 ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN days_since_install >= 30 AND has_reactji THEN 1 ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN days_since_install >= 30 AND has_membergate THEN 1 ELSE 0 END), 0)
         FROM feats`,
    )
    .all(floor);

const ticketsLifetimeCount = (
  db.prepare(`SELECT COUNT(*) AS cnt FROM tickets_config`).get() as {
    cnt: number;
  }
).cnt;

// F5 ---------------------------------------------------------------------
const f5 = (floor: string) =>
  db
    .prepare<
      [string],
      {
        install_month: string;
        cohort_size: number;
        active_7d: number;
        active_30d: number;
      }
    >(
      `WITH cohort AS (
         SELECT gs.guild_id, strftime('%Y-%m', gs.created_at) AS install_month
           FROM guild_subscriptions gs
          WHERE gs.created_at >= ?
       )
       SELECT install_month,
              COUNT(*) AS cohort_size,
              SUM(EXISTS(SELECT 1 FROM mod_actions m
                          WHERE m.guild_id = cohort.guild_id
                            AND m.created_at >= datetime('now','-7 days'))) AS active_7d,
              SUM(EXISTS(SELECT 1 FROM mod_actions m
                          WHERE m.guild_id = cohort.guild_id
                            AND m.created_at >= datetime('now','-30 days'))) AS active_30d
         FROM cohort
        GROUP BY install_month
       HAVING cohort_size >= 5`,
    )
    .all(floor);

// F6 ---------------------------------------------------------------------
const f6 = () =>
  db
    .prepare<[], { status: string; cnt: number }>(
      `SELECT status, COUNT(*) AS cnt
         FROM guild_subscriptions
        GROUP BY status
        ORDER BY status`,
    )
    .all();

// Assemble ----------------------------------------------------------------
interface Anchored<V> {
  cohort_floor: string;
  value: V;
  since_gtm?: V;
}

const anchored = <V>(
  cohort_floor: string,
  value: V,
  compute: (floor: string) => V,
): Anchored<V> =>
  GTM_LAUNCH_DATE
    ? { cohort_floor, value, since_gtm: compute(GTM_LAUNCH_DATE) }
    : { cohort_floor, value };

const f4Value = (floor: string) => ({
  windows: f4Windows(floor),
  tickets_lifetime: ticketsLifetimeCount,
});

const output = {
  snapshot_date: new Date().toISOString(),
  source_db_path: path.resolve(DATABASE_URL),
  gtm_launch_date: GTM_LAUNCH_DATE ?? null,
  metrics: {
    installs_per_week: anchored(FLOOR_INSTALLS, f1(FLOOR_INSTALLS), f1),
    trial_to_paid_conversion: anchored(FLOOR_INSTALLS, f2(FLOOR_INSTALLS), f2),
    ttfv_days: anchored(FLOOR_INSTALLS_STRICT, f3(FLOOR_INSTALLS_STRICT), f3),
    feature_activation_d7_d30: anchored(
      FLOOR_INSTALLS,
      f4Value(FLOOR_INSTALLS),
      f4Value,
    ),
    retention_7d_30d: anchored(
      FLOOR_INSTALLS_STRICT,
      f5(FLOOR_INSTALLS_STRICT),
      f5,
    ),
    churn_snapshot: { value: f6() },
  },
};

db.close();

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
