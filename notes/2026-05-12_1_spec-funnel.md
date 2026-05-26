# Phase 2 Spec: Funnel Snapshot

**Date:** 2026-05-12
**Branch:** `metrics-research`
**Source DB:** `prod-mod-bot.sqlite3` (read-only backup, taken 2026-05-12)
**Phase 1 reference:** `notes/2026-05-11_4_metrics-inventory.md`

## Pre-GTM disclaimer

Euno has not yet gone to market. The production backup reflects pre-GTM state:

- `guild_subscriptions` has **1 row** (Reactiflux), already on `product_tier='paid'` + `status='active'`. There is no `free`-tier cohort.
- `applications`, `application_config`, `background_jobs` are empty.
- 9 guilds appear in `guilds` (only those that have run `/setup-*` or web setup); the cross-table "install proxy" (`UNION` of `guild_id` across activity tables) yields **96 distinct guilds**, indicating many older guilds joined before `guild_subscriptions` shipped (2025-06-28) and never had `initializeFreeSubscription` called for them.

**Most numeric outputs below are 0 or 1.** That is correct and expected. Each metric is implementable today (the query does not crash on empty input) and will produce meaningful values automatically once OAuth installs accumulate from GTM. Each spec includes a **"Meaningful when"** threshold and the **specific GTM event** that will start producing data.

**Privacy contract for this spec sheet:** all funnel numbers are aggregate-only. No per-guild values are publishable — the single exception (Reactiflux) is the case-study surface, not the funnel snapshot, and lives in a separate spec.

---

## Headline snapshot table

| # | Metric | Current value | Meaningful when |
|---|---|---|---|
| 1 | Installs per week | **0/week since 2026-02-18 cohort floor**; 1 pre-floor row with corrupted `created_at` | ≥ 4 weeks of post-GTM OAuth installs (≥ 1 install/week) |
| 2 | Trial → paid conversion rate | **1/1 = 100% (n=1, not statistical)**; cohort: 2026-02 install month | ≥ 1 cohort of ≥ 20 free-tier installs has aged 90 days past install date |
| 3 | Time from install to first `mod_actions` row (TTFV) | **9.82 days (n=1, censored)**: install predates `mod_actions` ship date so this is a ship-date artifact, not real TTFV | ≥ 10 installs after 2026-02-20, all with `mod_actions` rows |
| 4 | Feature activation rate (lifetime view of `guild_subscriptions` cohort) | **n=1**: modLog 1/1, moderator 1/1, deletionLog 1/1, restricted 1/1, honeypot 1/1, reactji 0/1, membergate 0/1 | ≥ 20 installs aged ≥ 30 days, allowing real d7/d30 cohort cuts |
| 5 | Retention (active mod_actions in last 7/30d among install cohort) | **1/1 active@7d, 1/1 active@30d** (only Reactiflux qualifies for the 2026-02-20 cohort floor) | ≥ 20 installs aged ≥ 30 days past the 2026-02-20 floor |
| 6 | Churn (snapshot count of `guild_subscriptions` not in `active`) | **0** | Not meaningful as a snapshot at any volume; needs status-change audit trail — see metric for limitation |

---

## Cross-cutting caveats (apply to every metric)

These are inherited from Phase 1 inventory. Re-stated here so each spec can reference them by number without re-deriving.

- **C1. `guild_subscriptions` is the funnel anchor, but it undercounts pre-2025-06-28 installs.** Older guilds joined before the table shipped and have no row, because `GuildCreate` does not insert into `guild_subscriptions` (only OAuth completion and `setupAll` do). 96 distinct guilds appear across activity tables; only 1 has a `guild_subscriptions` row. **Post-GTM, every new install will hit OAuth and create a row, so this gap is bounded to the legacy cohort.**
- **C2. `guild_subscriptions.created_at` for any row predating 2026-02-18 is unrecoverable.** A migration on 2026-02-18 backfilled clobbered timestamps (literal string `'CURRENT_TIMESTAMP'` from a Kysely default bug) with `datetime('now')`. Use **2026-02-18 as the cohort floor** for any install-date analysis. The single prod row's `created_at = 2026-02-11` is pre-floor and therefore not trustworthy as an install date — it was likely written by the bugged path. (For Reactiflux specifically we know from other context the install is older; do not publish 2026-02-11 anywhere.)
- **C3. OAuth-completed ≠ setup-completed.** `initializeFreeSubscription` fires from both `session.server.ts:338` (OAuth callback) and `setupAll.server.ts:412` (end of setup). Both are upserts on `guild_id`. A guild that completed OAuth but abandoned setup still has a `guild_subscriptions` row. Layer `guilds.settings` (`modLog` + `moderator` keys) on top for "real activation". This is the basis of metric 4.
- **C4. `mod_actions` shipped 2026-02-20 with no backfill.** Any TTFV / retention metric anchored on `mod_actions` is right-censored for installs predating that ship date.
- **C5. Stripe webhook → `guild_subscriptions` writer path is not audited in this project.** Per the user's direction, we do not trace it here. Trial → paid conversion (metric 2) assumes the webhook correctly flips `product_tier` `free`→`paid` and updates `status`; if that path is buggy, this metric understates conversion. **Flagged here, not in metric 2's caveats, to avoid noise.**
- **C6. `tickets_config` has no `guild_id` column.** Per user direction, tickets activation is measured indirectly via `guilds.settings` (no setup writes a `tickets`-shaped key, so the indirect signal lives in feature-presence proxies like the existence of any `modLog`/`moderator` key plus `tickets_config` row total). Metric 4 omits tickets as a per-feature breakdown because there is no per-guild signal in SQL today.
- **C7. There is NO audit trail for `guild_subscriptions.status` changes.** Status flips are in-place updates. Sentry breadcrumbs are the only history. This is the binding limitation for metric 6.
- **C8. `reported_messages` has 82 rows with numeric-string `reason` values (e.g. `'0'`, `'2'`, `'33'`).** Funnel metrics do not directly touch `reported_messages`, but if any future funnel metric reads from it, filter `WHERE reason IN ('anonReport','track','spam','modResolution','automod')`.

---

## Per-metric specs

### M1. Installs per week

**Definition:** Count of new `guild_subscriptions` rows created per ISO week. Anchored on `guild_subscriptions.created_at`.

**Audience:** Funnel (cross-guild aggregate). Aggregate-only.

**Source query:**

```sql
-- Weekly installs since the 2026-02-18 cohort floor (C2).
SELECT
  strftime('%Y-W%W', created_at) AS week,
  COUNT(*) AS installs
FROM guild_subscriptions
WHERE created_at >= '2026-02-18'
GROUP BY week
ORDER BY week;

-- Companion: count of legacy rows excluded by the cohort floor (informational).
SELECT COUNT(*) AS excluded_pre_floor
FROM guild_subscriptions
WHERE created_at < '2026-02-18';
```

**Current value (2026-05-12):**

- Weekly bucket query returns **zero rows**. There have been zero installs since the 2026-02-18 cohort floor.
- Excluded-pre-floor: **1** (Reactiflux, `created_at = 2026-02-11T03:19:27.270Z`, but per C2 this timestamp is not trustworthy).

**Caveats:**

- C1: undercounts pre-2025-06-28 installs entirely (no row at all). Mitigated post-GTM.
- C2: 2026-02-18 cohort floor is mandatory. Rows pre-floor have synthesized timestamps from the corruption-fix migration.
- C3: a "row in `guild_subscriptions`" means OAuth-completed, not "set up". Acceptable for "installs" — that's what `initializeFreeSubscription` records — but be precise in any external comm: this is **"OAuth-completed installs per week"**, not "active guilds per week".

**Validation method:**

- Query produces zero rows today, as expected (the only existing row predates the cohort floor).
- Re-validate post-GTM by spot-checking the first week with a non-zero count: count of new rows should equal count of new OAuth-completed installs reported by Sentry breadcrumbs / Stripe customer creations within the same window.

**Publishability:**

- Internal only at current volume.
- Aggregate-publishable on the GTM page once weekly count > 1 (so we are not effectively publishing per-guild data).

**Meaningful when:** ≥ 4 weeks of post-GTM data exist, with at least 1 install per week on average. Below this threshold the metric is noise.

---

### M2. Trial → paid conversion rate

**Definition:** Of guilds whose `guild_subscriptions.created_at` falls in install month X (and started on `product_tier='free'`), the percentage now on `product_tier='paid'` after the 90-day trial window closes (i.e., evaluated only for cohorts where `created_at` is ≥ 90 days in the past). 90-day trial window comes from `app/models/stripe.server.ts:56` (`trial_period_days: 90`).

**Audience:** Funnel (cross-guild aggregate). Aggregate-only.

**Source query:**

```sql
-- Conversion rate by install-month cohort, restricted to cohorts whose 90-day window has closed.
WITH cohorts AS (
  SELECT
    strftime('%Y-%m', created_at) AS install_month,
    product_tier,
    created_at,
    julianday('now') - julianday(created_at) AS days_since_install
  FROM guild_subscriptions
  WHERE created_at >= '2026-02-18'  -- C2: cohort floor
)
SELECT
  install_month,
  COUNT(*) AS cohort_size,
  SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) AS converted_to_paid,
  ROUND(100.0 * SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) / COUNT(*), 1) AS conversion_pct
FROM cohorts
WHERE days_since_install >= 90
GROUP BY install_month
HAVING cohort_size >= 5  -- avoid publishing tiny-N
ORDER BY install_month;

-- Companion: in-flight cohorts (install < 90 days ago) — internal only, never publish.
WITH cohorts AS (
  SELECT
    strftime('%Y-%m', created_at) AS install_month,
    product_tier,
    julianday('now') - julianday(created_at) AS days_since_install
  FROM guild_subscriptions
  WHERE created_at >= '2026-02-18'
)
SELECT
  install_month,
  COUNT(*) AS cohort_size,
  SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) AS paid_today,
  ROUND(100.0 * SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_paid_today
FROM cohorts
WHERE days_since_install < 90
GROUP BY install_month
ORDER BY install_month;
```

**Current value (2026-05-12):**

- Closed-cohort query: **zero rows** (no install in `guild_subscriptions` since 2026-02-18, so no cohort exists to close).
- In-flight cohort query: zero rows (same reason).
- Manually inspecting the single Reactiflux row: `product_tier='paid'`, `status='active'`, `current_period_end=2027-05-12`. Not part of a trial cohort because the install predates the cohort floor and the row was likely written directly to `paid` by the Stripe webhook (not via `initializeFreeSubscription` → trial → paid).

**Caveats:**

- C1, C2, C3 all apply.
- C5: trial→paid attribution depends on the Stripe webhook → `guild_subscriptions` writer path being correct. The team is not auditing that path in this project. If the webhook fails or misroutes, this metric will silently under-report conversions even with real data.
- The `HAVING cohort_size >= 5` guard prevents publishing single-guild cohort percentages (a privacy / signal-quality floor; tune up when volume grows).
- A guild's `product_tier` value at query time is the **current** value, not a snapshot at day-90. C7 (no audit trail) means we cannot detect a guild that converted to paid and then churned back to free during the trial — but in practice the writer path only flips on Stripe events, so a free→paid→free flip would require an explicit cancellation, which would also flip `status` to `inactive`.

**Validation method:**

- Query produces zero rows today, as expected. The shape of the query is validated by inspecting the single row manually (`product_tier='paid'`, would be counted as 1/1 if it were in a closed cohort window after the floor).
- Re-validate post-GTM by cross-referencing Stripe customer subscription events for the first closed cohort against the `product_tier='paid'` count.

**Publishability:**

- Internal only until the first cohort with `cohort_size >= 20` closes (so the rate is statistically meaningful and the `HAVING` guard's relaxation is safe).
- Aggregate-publishable on the GTM page once threshold is met. Never publish per-month cohorts below `cohort_size >= 20`.

**Meaningful when:** at least one install-month cohort has `cohort_size >= 20` AND has aged ≥ 90 days past install. With a hypothetical GTM target of "5 OAuth installs/week", this is ~earliest mid-September 2026 if GTM launches at the end of May 2026.

---

### M3. Time from install to first `mod_actions` row (TTFV)

**Definition:** Per guild in `guild_subscriptions`, the elapsed time between `guild_subscriptions.created_at` and `MIN(mod_actions.created_at)` for that `guild_id`. Aggregated across the cohort: count, min, mean, median, max. Time-to-first-value metric — the gap between "they installed" and "they got value out of the bot".

**Audience:** Funnel (cross-guild aggregate). Aggregate-only.

**Source query:**

```sql
WITH first_actions AS (
  SELECT guild_id, MIN(created_at) AS first_action_at
  FROM mod_actions
  GROUP BY guild_id
),
ttfv AS (
  SELECT
    julianday(fa.first_action_at) - julianday(gs.created_at) AS days
  FROM guild_subscriptions gs
  JOIN first_actions fa ON fa.guild_id = gs.guild_id
  WHERE gs.created_at >= '2026-02-20'  -- C4: mod_actions ship date floor
)
SELECT
  COUNT(*) AS sample_n,
  ROUND(MIN(days), 2) AS min_days,
  ROUND(AVG(days), 2) AS avg_days,
  ROUND(MAX(days), 2) AS max_days
FROM ttfv;

-- Companion: % of installed guilds that have NOT YET had a first mod action
-- (censored — they may have one tomorrow). Internal only.
SELECT
  COUNT(*) AS cohort_size,
  SUM(CASE WHEN fa.first_action_at IS NULL THEN 1 ELSE 0 END) AS without_first_action,
  ROUND(100.0 * SUM(CASE WHEN fa.first_action_at IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_without_first_action
FROM guild_subscriptions gs
LEFT JOIN (
  SELECT guild_id, MIN(created_at) AS first_action_at
  FROM mod_actions
  GROUP BY guild_id
) fa ON fa.guild_id = gs.guild_id
WHERE gs.created_at >= '2026-02-20';
```

**Current value (2026-05-12):**

- Primary query: **`sample_n=0`** (no install in `guild_subscriptions` since 2026-02-20, so the cohort is empty).
- Companion query: zero rows.
- If we drop the cohort floor and look at the single existing row: install was 2026-02-11 (untrustworthy per C2), first `mod_action` was 2026-02-20T22:59:57 — exactly 9.82 days. **This is a ship-date artifact**: `mod_actions` literally did not exist before 2026-02-20, so this "TTFV" is the gap between Reactiflux's clobbered install date and the table's ship date. **Not a real TTFV value.**

**Caveats:**

- C2: 2026-02-18 cohort floor on `guild_subscriptions.created_at`.
- C4: 2026-02-20 cohort floor on `mod_actions` (no rows before this date). The primary query uses 2026-02-20 (the stricter of the two) so the metric is honest.
- Guilds in the install cohort that have NOT YET had a first `mod_action` are right-censored. The primary query excludes them (only INNER JOIN matches contribute), so it represents "TTFV among guilds that have reached first-value". The companion query exposes the censoring rate.
- A `mod_action` is either a human-issued ban/kick/timeout (executor_id non-null) or a Discord-native automod timeout (executor_id NULL per Phase 1). Both count as "value". This is deliberate — TTFV measures "did the bot do its job for them?", not "did a human use the bot?".

**Validation method:**

- Query produces zero rows today, as expected.
- Re-validate post-GTM by spot-checking a small cohort: for each guild in the first 10 post-GTM installs that produce a `mod_action`, manually confirm the timestamp difference is reasonable (hours-to-days, not negative, not > 90 days for active guilds).

**Publishability:**

- Internal only at current volume.
- Aggregate-publishable on the GTM page when `sample_n >= 20`. Headline: report median (more robust than mean for heavy-tailed elapsed-time distributions). The current query reports mean; switch to median once SQLite version permits (or compute outside SQL).

**Meaningful when:** `sample_n >= 20` in the primary query. Pre-condition: ≥ 20 post-GTM installs have occurred AND each has produced at least one `mod_action` row.

---

### M4. Feature activation rate at day 7 / day 30

**Definition:** Among guilds in the install cohort, the percentage that have activated each individual feature by day 7 and day 30 after their `guild_subscriptions.created_at`. Activation per feature:

- **modLog:** `JSON_EXTRACT(guilds.settings, '$.modLog') IS NOT NULL`
- **moderator:** `JSON_EXTRACT(guilds.settings, '$.moderator') IS NOT NULL`
- **deletionLog:** `JSON_EXTRACT(guilds.settings, '$.deletionLog') IS NOT NULL`
- **restricted (escalation-restricted role):** `JSON_EXTRACT(guilds.settings, '$.restricted') IS NOT NULL`
- **honeypot:** `EXISTS(SELECT 1 FROM honeypot_config WHERE guild_id = X)`
- **reactji-channeler:** `EXISTS(SELECT 1 FROM reactji_channeler_config WHERE guild_id = X)`
- **member-gate (mod applications):** `EXISTS(SELECT 1 FROM application_config WHERE guild_id = X)`

**Tickets is intentionally omitted from per-feature breakdown.** Per C6, `tickets_config` has no `guild_id` column. There is no setting key written by tickets setup that lives in `guilds.settings` (verified: setup paths in `setupAll.server.ts` and `setupTickets.ts` write to `tickets_config` and modify `guilds.settings.modLog`/`moderator`, neither of which is tickets-specific). The total row count in `tickets_config` (currently 9) can be reported as a lifetime aggregate but **not** per-cohort or as a percentage of installs.

**Important d7/d30 caveat:** none of the `*_config` tables nor `guilds.settings` carry an activation-timestamp column. Activation date for the d7/d30 cut is approximated by checking the current state at query time, gated by whether the install has aged ≥ 7 or ≥ 30 days. **This conflates "activated by day N" with "activated at any time, and currently aged ≥ N days"** — a guild that installed 60 days ago and configured honeypot yesterday will count as "activated by day 30". This overstates d7/d30 activation. The error is bounded for fast activations (most setup happens within hours per `setupAll`'s synchronous flow); it grows for slow opt-in features like honeypot. **Treat the resulting numbers as upper bounds. The proper fix is `created_at` columns on the `*_config` tables (filed as an out-of-scope follow-up in Phase 1).**

**Audience:** Funnel (cross-guild aggregate). Aggregate-only.

**Source query:**

```sql
WITH cohort AS (
  SELECT
    gs.guild_id,
    gs.created_at AS installed_at,
    julianday('now') - julianday(gs.created_at) AS days_since_install
  FROM guild_subscriptions gs
  WHERE gs.created_at >= '2026-02-18'  -- C2
),
feats AS (
  SELECT
    c.guild_id,
    c.days_since_install,
    (SELECT JSON_EXTRACT(g.settings, '$.modLog') FROM guilds g WHERE g.id = c.guild_id) IS NOT NULL AS has_modLog,
    (SELECT JSON_EXTRACT(g.settings, '$.moderator') FROM guilds g WHERE g.id = c.guild_id) IS NOT NULL AS has_moderator,
    (SELECT JSON_EXTRACT(g.settings, '$.deletionLog') FROM guilds g WHERE g.id = c.guild_id) IS NOT NULL AS has_deletionLog,
    (SELECT JSON_EXTRACT(g.settings, '$.restricted') FROM guilds g WHERE g.id = c.guild_id) IS NOT NULL AS has_restricted,
    EXISTS(SELECT 1 FROM honeypot_config hc WHERE hc.guild_id = c.guild_id) AS has_honeypot,
    EXISTS(SELECT 1 FROM reactji_channeler_config rcc WHERE rcc.guild_id = c.guild_id) AS has_reactji,
    EXISTS(SELECT 1 FROM application_config ac WHERE ac.guild_id = c.guild_id) AS has_membergate
  FROM cohort c
)
SELECT
  'd7' AS window,
  SUM(CASE WHEN days_since_install >= 7 THEN 1 ELSE 0 END) AS eligible,
  SUM(CASE WHEN days_since_install >= 7 AND has_modLog THEN 1 ELSE 0 END) AS modLog,
  SUM(CASE WHEN days_since_install >= 7 AND has_moderator THEN 1 ELSE 0 END) AS moderator,
  SUM(CASE WHEN days_since_install >= 7 AND has_deletionLog THEN 1 ELSE 0 END) AS deletionLog,
  SUM(CASE WHEN days_since_install >= 7 AND has_restricted THEN 1 ELSE 0 END) AS restricted,
  SUM(CASE WHEN days_since_install >= 7 AND has_honeypot THEN 1 ELSE 0 END) AS honeypot,
  SUM(CASE WHEN days_since_install >= 7 AND has_reactji THEN 1 ELSE 0 END) AS reactji,
  SUM(CASE WHEN days_since_install >= 7 AND has_membergate THEN 1 ELSE 0 END) AS membergate
FROM feats
UNION ALL
SELECT
  'd30',
  SUM(CASE WHEN days_since_install >= 30 THEN 1 ELSE 0 END),
  SUM(CASE WHEN days_since_install >= 30 AND has_modLog THEN 1 ELSE 0 END),
  SUM(CASE WHEN days_since_install >= 30 AND has_moderator THEN 1 ELSE 0 END),
  SUM(CASE WHEN days_since_install >= 30 AND has_deletionLog THEN 1 ELSE 0 END),
  SUM(CASE WHEN days_since_install >= 30 AND has_restricted THEN 1 ELSE 0 END),
  SUM(CASE WHEN days_since_install >= 30 AND has_honeypot THEN 1 ELSE 0 END),
  SUM(CASE WHEN days_since_install >= 30 AND has_reactji THEN 1 ELSE 0 END),
  SUM(CASE WHEN days_since_install >= 30 AND has_membergate THEN 1 ELSE 0 END)
FROM feats;

-- Companion: lifetime aggregate over the cohort (no d7/d30 gate). Useful when cohort is too small for windowed cuts.
-- Also useful for reporting `tickets_config` row count (no guild_id column, see C6).
SELECT
  COUNT(*) AS cohort_size,
  SUM(has_modLog) AS modLog,
  SUM(has_moderator) AS moderator,
  SUM(has_deletionLog) AS deletionLog,
  SUM(has_restricted) AS restricted,
  SUM(has_honeypot) AS honeypot,
  SUM(has_reactji) AS reactji,
  SUM(has_membergate) AS membergate,
  (SELECT COUNT(*) FROM tickets_config) AS tickets_rows_lifetime
FROM feats;
```

**Current value (2026-05-12):**

Primary query (with `created_at >= '2026-02-18'` cohort floor): **zero rows** (single existing `guild_subscriptions` row predates floor).

Dropping the cohort floor and reporting against the single existing row (Reactiflux, install 2026-02-11):

| feature | activated? |
|---|---|
| modLog | yes |
| moderator | yes |
| deletionLog | yes |
| restricted | yes |
| honeypot | yes (1 honeypot_config row for this guild) |
| reactji | no |
| membergate | no |

Lifetime aggregates (across the broader install proxy, for context — not the metric, not for publication): `tickets_config`=9 rows, `honeypot_config`=2 rows (2 guilds), `reactji_channeler_config`=2 rows (1 guild), `application_config`=0 rows.

**Caveats:**

- C1, C2, C3 all apply.
- C6: tickets omitted from per-feature breakdown.
- The d7/d30 cuts use "current state at query time, gated by install age" — an upper bound, not a true cohort cut, until `*_config` tables grow `created_at` columns.
- `application_config` and `honeypot_config` have no `created_at`; `reactji_channeler_config` does. Even where the column exists, the queries above use existence-at-query-time for consistency with the others. (Once instrumentation is fixed, swap to `MIN(created_at) - installed_at <= 7d`.)
- `moderator` and `modLog` are nearly always present together (both set by the same setup path). Treating them as independent features overstates activation diversity — they are effectively a single "completed initial setup" signal.

**Validation method:**

- Query against the cohort produces zero rows today, as expected.
- Companion / lifetime query produces a single row with the values listed above; spot-checked against `guilds.settings` JSON manually.
- Re-validate post-GTM by sampling 5 guilds from the d30 cohort and confirming their `guilds.settings` JSON matches the boolean signals.

**Publishability:**

- Internal only at current volume.
- Aggregate-publishable per-feature once the cohort eligible for d30 has `n >= 20`. Per-feature percentages on the GTM page; never per-guild.

**Meaningful when:** `eligible >= 20` for both the d7 and d30 windows. Pre-condition: ≥ 20 post-GTM installs aged ≥ 30 days.

---

### M5. Retention (active in last 7/30 days)

**Definition:** Percentage of guilds in the install cohort that have at least one `mod_actions` row in the last 7 (resp. 30) days. Strict 2026-02-20 cohort floor (C4).

**Audience:** Funnel (cross-guild aggregate). Aggregate-only.

**Source query:**

```sql
WITH cohort AS (
  SELECT
    gs.guild_id,
    strftime('%Y-%m', gs.created_at) AS install_month
  FROM guild_subscriptions gs
  WHERE gs.created_at >= '2026-02-20'  -- C4: stricter of mod_actions ship + install corruption floor
),
recency AS (
  SELECT
    c.install_month,
    c.guild_id,
    EXISTS(
      SELECT 1 FROM mod_actions m
      WHERE m.guild_id = c.guild_id
        AND m.created_at >= datetime('now','-7 days')
    ) AS active_7d,
    EXISTS(
      SELECT 1 FROM mod_actions m
      WHERE m.guild_id = c.guild_id
        AND m.created_at >= datetime('now','-30 days')
    ) AS active_30d
  FROM cohort c
)
SELECT
  install_month,
  COUNT(*) AS cohort_size,
  SUM(active_7d) AS active_7d_cnt,
  SUM(active_30d) AS active_30d_cnt,
  ROUND(100.0 * SUM(active_7d) / COUNT(*), 1) AS retention_7d_pct,
  ROUND(100.0 * SUM(active_30d) / COUNT(*), 1) AS retention_30d_pct
FROM recency
GROUP BY install_month
HAVING cohort_size >= 5
ORDER BY install_month;

-- Companion: aggregate over all cohorts (used when no single cohort is large enough).
SELECT
  COUNT(*) AS cohort_size,
  SUM(EXISTS(SELECT 1 FROM mod_actions m WHERE m.guild_id = gs.guild_id AND m.created_at >= datetime('now','-7 days'))) AS active_7d,
  SUM(EXISTS(SELECT 1 FROM mod_actions m WHERE m.guild_id = gs.guild_id AND m.created_at >= datetime('now','-30 days'))) AS active_30d
FROM guild_subscriptions gs
WHERE gs.created_at >= '2026-02-20';
```

**Current value (2026-05-12):**

- Primary cohort query: **zero rows** (no `guild_subscriptions` row passes the 2026-02-20 floor; the `HAVING cohort_size >= 5` clause is doubly defensive).
- Companion: also zero (same filter).
- For context, **5 distinct guilds** have a `mod_actions` row in the last 30 days, but only 1 of them (Reactiflux) has a `guild_subscriptions` row — the other 4 are legacy installs with no funnel anchor (C1).

**Caveats:**

- C1: legacy installs without a `guild_subscriptions` row never enter the cohort, so this metric measures retention of the **post-GTM cohort only**. That is correct for GTM funnel reporting but undercounts overall product health.
- C2 + C4: 2026-02-20 floor is the stricter of the two.
- Retention is defined as "has any `mod_action` in the window". A guild that uses anonymous reports / escalations / tickets but never produces a `mod_action` will register as "not retained" — false negative. **Definition choice**: this is the narrowest, most defensible signal of "the bot is doing moderation work for them". If we want a softer signal, layer `UNION` of `escalation_records.voter_id`, `reported_messages.staff_id`, etc. Phase 1 follow-up #6 surfaces this open question; defaulting to the narrow definition.
- C7: this is a "currently active" snapshot, not "retained from install". A guild that was active in week 1, idle in weeks 2–4, then active in week 5 will count as retained at 30d — which is correct ("retention" not "continuous activity").

**Validation method:**

- Query produces zero rows today, as expected (no qualifying cohort).
- Re-validate post-GTM by spot-checking a single cohort against direct `SELECT DISTINCT guild_id FROM mod_actions WHERE created_at >= datetime('now','-30 days')` constrained to cohort guilds.

**Publishability:**

- Internal only at current volume.
- Aggregate-publishable when at least one install-month cohort has `cohort_size >= 20`.

**Meaningful when:** ≥ 1 install-month cohort with `cohort_size >= 20`. Realistic timing: post-GTM, after the first month with ≥ 20 OAuth installs.

---

### M6. Churn (snapshot of non-active subscriptions)

**Definition:** Current count of `guild_subscriptions` rows with `status != 'active'`. **This is a snapshot, not a flow.**

**Audience:** Funnel (cross-guild aggregate). Aggregate-only.

**Source query:**

```sql
SELECT status, COUNT(*) AS cnt
FROM guild_subscriptions
GROUP BY status
ORDER BY status;

-- Companion: count of churned (non-active) and ratio.
SELECT
  COUNT(*) AS total_subs,
  SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) AS non_active,
  ROUND(100.0 * SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS pct_non_active
FROM guild_subscriptions;
```

**Current value (2026-05-12):**

- Status breakdown: **`active` = 1, all other = 0**.
- Total = 1, non-active = 0, pct_non_active = 0.0%.

**Caveats — the binding limitation:**

- **C7 (no audit trail for status changes).** `guild_subscriptions.status` is updated in place by `updateSubscriptionStatus` (`subscriptions.server.ts:144`) and by the Stripe webhook handler (`app/routes/webhooks.stripe.tsx:129` sets `'active'`, `:219` sets `'inactive'`). There is no history table. A guild that subscribed, churned, then re-subscribed will look identical to a guild that subscribed once.
- **This metric is a snapshot, not a flow.** "Churn rate" as conventionally understood (subscribers lost in period / subscribers at start of period) is **not computable from this DB alone**. To compute it properly we would need either (a) a `subscription_status_changes` audit table, or (b) cross-reference Stripe events (out of scope per the user's direction not to trace the webhook path). Sentry breadcrumbs from `auditSubscriptionChanges` are the only existing history, and they are not queryable from SQL.
- **What this metric can answer:** "right now, what fraction of subscriptions are not active?" — a thermometer reading. It cannot distinguish "1% churned this month" from "10% churned cumulatively over 10 months".
- C1, C2 apply but are dwarfed by C7. Pre-GTM, the metric is 0/1 = 0% — no signal.
- Observed status enum values from writer paths: `active`, `inactive`. The DB schema has no CHECK constraint so other values are possible. Future status values added without notice will skew this metric.

**Validation method:**

- Query produces `active=1` today, matching the row count.
- Re-validate post-GTM by **filing a follow-up to instrument status changes** (e.g., write to a `subscription_events` table or PostHog event) so a true churn-rate metric becomes computable. Without that instrumentation, the metric stays a snapshot indefinitely.

**Publishability:**

- **Not publishable in any form until C7 is addressed.** A snapshot like "0% non-active" or "5% non-active" is misleading without context. Internal only.
- If we want a publishable churn number on the GTM page, the prerequisite is instrumentation, not query tuning.

**Meaningful when:** **Never, as currently specified.** This metric is a snapshot, not a flow. To produce a meaningful churn rate, the prerequisite is an instrumentation change: write to a `subscription_events` (or similar) audit log on every `status` transition. Once that exists, churn rate = (transitions from `active` to non-`active` in window) / (count of `active` at window start). Until then, the snapshot count above is the best available signal — and it is signal-poor.

---

## Open questions for the user

1. **Definition of "active" in retention (M5).** Default is "≥ 1 `mod_action` in window". Alternatives: UNION with `escalation_records.voter_id`, `reported_messages.staff_id`, any setup-write. Narrow default is more defensible; broader is more flattering. Confirm narrow default is the published number.
2. **Reactiflux's `guild_subscriptions.created_at = 2026-02-11`.** This predates the 2026-02-18 corruption-fix floor, so it is technically untrustworthy. But the row was likely written by the Stripe webhook (status=paid, has Stripe IDs) and may have a real install date. Should the funnel snapshot include this row (relaxing the floor for Stripe-customer rows) or exclude it consistently with the floor? Current spec excludes it — that's the conservative choice.
3. **Trial → paid conversion definition (M2): "at any point during the trial" vs "still paid at trial+30d".** Current spec is "currently paid at query time, evaluated only for closed (≥ 90 day) cohorts". A stricter alternative is "paid AND active AND `current_period_end > now` AND created_at >= 90 days ago". Confirm the lenient default.
4. **Honeypot / member-gate sample threshold.** Current spec uses `HAVING cohort_size >= 5` in some queries and `>= 20` in publishability gates. Confirm the right thresholds — these are guesses to prevent thin-N publication; they should probably be one number across all funnel metrics.
5. **Churn metric (M6) — do we want a follow-up filed to instrument status changes?** Without it, this metric is permanently signal-poor. Filing the follow-up is outside this spec's scope but is the only path to a real churn number. Confirm whether to file.
6. **Cohorts pre-GTM.** Per direction, this spec assumes GTM has not happened. If GTM happens between this spec's date and the first re-run, do we add a "GTM launch date" marker (e.g., 2026-06-01) and report all metrics with `created_at >= gtm_launch_date` as an additional column? Worth threading into the Phase 3 script.
