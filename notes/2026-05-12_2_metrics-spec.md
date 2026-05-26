# Phase 2 Deliverable: Metrics Spec

**Date:** 2026-05-12
**Branch:** `metrics-research`
**Source DB for validation:** `prod-mod-bot.sqlite3` (backup taken 2026-05-12)
**Reactiflux guild ID:** `102860784329052160`
**Bot user ID** (must be excluded from "distinct mods" unions): `984212151608705054`

**Companion docs:**

- `notes/2026-05-12_0_spec-case-study.md` — full case-study spec with validation methods, customer-facing copy framing, and per-metric caveat prose (read this for the deep dive on any case-study metric below)
- `notes/2026-05-12_1_spec-funnel.md` — full funnel spec with cross-cutting caveats C1–C8 and the "meaningful when" thresholds
- `notes/2026-05-11_4_metrics-inventory.md` — Phase 1 reference (cohort gates, five traps)

**This document is the contract Phase 3 scripts implement.** Every source query below has been validated against the prod backup; the "Current value" column reflects state at 2026-05-12. Phase 3 agents implement these queries verbatim in Kysely.

---

## Pre-GTM disclaimer

Euno has not yet gone to market. Funnel metrics produce zero or single-digit values today (the only `guild_subscriptions` row is Reactiflux, written directly to `paid` by the Stripe webhook). This is expected per the user's direction; the funnel script must run cleanly on empty inputs and produce meaningful output automatically once OAuth installs accumulate.

The case-study side is healthy: 12 escalations, 1,353 staff track reports, 629 anonymous reports, 700 auto-handled spam events, 828K message_stats rows for Reactiflux specifically.

---

## Headline metrics summary

### Case study (Reactiflux only)

| # | Metric | Current value | Publishable? |
|---|---|---|---|
| 1 | Spam interruptions saved (30d) | 113 events / 226 minutes | Yes |
| 1 | Spam interruptions saved (90d) | 247 events / 494 minutes | Yes |
| 2 | Escalations initiated / resolved | 12 / 12 (100%) | Yes |
| 2 | Time-to-resolve, unscheduled bucket | 3–16 hours (n=3) | Yes with n disclosure |
| 3 | Distinct escalation voters | 5 across 10 voted escalations | Yes |
| 3 | Voter participation rate | 5 / 20 active mods = 25% | Yes ("of active mods") |
| 4 | Anonymous reports (lifetime) | 629 | Yes |
| 4 | Staff track reports (lifetime) | 1,353 | Yes |
| 5 | Anonymous → enforcement (24h) | 21 / 128 = 16.4% | Yes |
| 5 | All reports → enforcement (24h) | 52 / 463 = 11.2% | Internal preferred |
| 6 | Peak active mods (Jan 2026) | 18 distinct mods | Yes |
| 6 | Active mods, monthly range (Aug 2025–Apr 2026) | 8–18 | Yes |
| 7 | Messages tracked, lifetime | 828,589 (since 2024-10-08) | Yes "more than 800,000" |
| 7 | Messages tracked, last 30d | 31,689 | Yes |

### Funnel snapshot (cross-guild aggregate, pre-GTM)

| # | Metric | Current value | Meaningful when |
|---|---|---|---|
| M1 | Installs per week | 0/week since 2026-02-18 floor | ≥ 4 post-GTM weeks |
| M2 | Trial → paid conversion | 0 cohorts qualify (n=0) | ≥ 1 cohort of ≥ 20 free installs aged ≥ 90 days |
| M3 | TTFV (install → first mod_action) | sample_n=0 with cohort floor | ≥ 20 post-GTM installs with a mod_action |
| M4 | Feature activation rate d7/d30 | n=0 with cohort floor | ≥ 20 installs aged ≥ 30 days |
| M5 | Retention (active in last 7/30d) | cohort_size=0 | ≥ 1 install-month cohort of ≥ 20 |
| M6 | Churn (snapshot of non-active subs) | 0 / 1 = 0% | Never as snapshot; needs status-change instrumentation |

---

## Decisions made on open questions (defaults locked in)

The two Phase 2 agents collectively raised 13 open questions. The user has already answered some via prior direction; the rest I've defaulted with stated reasoning. **Two questions still need user input** — see "User decisions required" below.

1. **"2 minutes per spam interruption" multiplier.** Locked at 2 minutes per the user's 2026-05-11 direction (see `project_interruptions_model.md` memory). Frame as "interruptions saved", never "mod-hours saved".
2. **Conversion-rate window (24h vs 7d).** Default: **lead with 24h**, report 7d as secondary. The 7d window adds only marginal lift (16.4% → 18.8% for `anonReport`) and 24h is the natural SLA window.
3. **Reactiflux mod-team roster size for metric 3 denominator.** Default: use "active mods who used the bot during the escalation window" (n=20). Frame the percentage as "of active mods", NOT "of all mods on the team". Re-anchor if user supplies roster.
4. **Escalation time-to-resolution framing.** Default: **lead with "100% of escalations reached resolution"**; mention unscheduled bucket ("3–16 hours, n=3") as the speed signal. Do not publish a single average — the scheduled-deliberation windows make the raw mean misleading.
5. **May 2026 partial-month handling in active-mods chart.** Default: cap publishable copy at April 2026; label May 2026 as MTD in any internal view. Re-evaluate at publish time.
6. **Back-fill rate inconsistency (Reactiflux 0.4% vs global ~13%).** Not a spec blocker. Logged as a follow-up investigation item.
7. **3 spam rows with `staff_id IS NULL` anomaly.** Not a spec blocker. Logged as a follow-up.
8. **M5 "active" definition.** Default: **narrow** — `mod_actions` only. More defensible; sets a floor. The broader UNION (`reported_messages.staff_id` + `escalation_records.voter_id`) is available if we later want to soften.
9. **Reactiflux's pre-floor `guild_subscriptions.created_at = 2026-02-11`.** Default: **exclude** from funnel cohort queries (consistent with the 2026-02-18 floor). The row's install date is untrustworthy; admitting it as cohort-0 would bias every metric.
10. **M2 conversion definition.** Default: **"currently `product_tier='paid'`, evaluated only for cohorts whose install month ended ≥ 90 days ago"**. Lenient and aligned with how Stripe webhooks actually mutate the row.
11. **Sample-size thresholds.** Standardized: `HAVING cohort_size >= 5` in queries (signal-quality floor); `cohort_size >= 20` for publication gates.
12. **Churn instrumentation follow-up.** **Surfacing to user — see below.**
13. **GTM launch marker in scripts.** Default: **yes**. Phase 3 funnel script accepts an optional `GTM_LAUNCH_DATE` env var; metrics emit a `since_gtm` view alongside the full view if set.

---

## User decisions required

Only two items genuinely need your input before Phase 3 ships:

**Q1.** Do you want to **file a separate instrumentation follow-up** to write `guild_subscriptions.status` transitions to an audit log (or PostHog event)? Without it, the churn metric is permanently a snapshot, not a flow. This is out of scope for the metrics project but is the prerequisite for a real churn-rate number on the GTM page. Answer Y/N — I'll file if Y, drop the issue if N.

**Q2.** Do you want me to lead with **the conservative funnel framing** ("the funnel snapshot has no data yet because we're pre-GTM; here's what it'll measure when it does") or the **operational framing** ("zero installs this week, zero conversions, healthy zero" — i.e., publish the zeros as evidence the pipeline works)? Both are honest; they read differently to the same reader.

If you're happy with my defaults on the other 11 items, I'll proceed.

---

## Per-metric spec (the contract for Phase 3)

### Case-study metrics — output: Markdown report for the Reactiflux case-study page

For each case-study metric, the Phase 3 script must:
- Filter `WHERE guild_id = '102860784329052160'` (Reactiflux only).
- Apply the cohort gate noted per metric.
- Apply the `reported_messages` corrupt-row filter `reason IN ('anonReport','track','spam','modResolution','automod')` on any `reported_messages` query.
- Exclude the bot user ID `984212151608705054` from any "distinct mods" union.
- Output the date generated and the time window for each metric in the Markdown.
- **Avoid "wedge" in customer-facing language** (see `feedback_wedge_internal_jargon.md`). Use plain feature names.

#### CS1. Spam interruptions saved

```sql
SELECT
  COUNT(*) AS spam_events,
  COUNT(*) * 2 AS minutes_saved
FROM reported_messages
WHERE guild_id = '102860784329052160'
  AND reason = 'spam'
  AND (extra IS NULL OR extra NOT LIKE 'Back-filled%')
  AND created_at >= datetime('now', '-30 days');
```

Repeat with `'-90 days'` and lifetime. Cohort floor: 2025-07-26. Validation: cross-check against `mod_actions WHERE executor_id IS NULL AND action_type='timeout'` in the same window (Discord-native automod is a separate signal — counts won't match, just confirm order of magnitude).

#### CS2. Escalations: initiated, resolved, time-to-resolve

```sql
SELECT COUNT(*) AS initiated,
       SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
FROM escalations
WHERE guild_id = '102860784329052160';

SELECT
  CASE WHEN scheduled_for IS NULL OR scheduled_for=''
       THEN 'unscheduled' ELSE 'scheduled' END AS bucket,
  COUNT(*) AS n,
  ROUND(AVG((julianday(resolved_at) - julianday(created_at)) * 24), 1) AS avg_hours,
  ROUND(MIN((julianday(resolved_at) - julianday(created_at)) * 24), 1) AS min_hours,
  ROUND(MAX((julianday(resolved_at) - julianday(created_at)) * 24), 1) AS max_hours
FROM escalations
WHERE guild_id = '102860784329052160' AND resolved_at IS NOT NULL
GROUP BY bucket;
```

Cohort floor: 2025-11-28. Headline: "100% resolution rate"; secondary: unscheduled time range. Caveat: `resolution='track'` is overloaded — do not break out resolutions in customer copy without the trap explanation.

#### CS3. Voter participation rate

```sql
-- distinct voters across all Reactiflux escalations
SELECT COUNT(DISTINCT er.voter_id)
FROM escalation_records er
JOIN escalations e ON e.id = er.escalation_id
WHERE e.guild_id = '102860784329052160'
  AND er.voter_id != '984212151608705054';

-- eligible-mod denominator: active during the escalation window
SELECT COUNT(DISTINCT mod_id) FROM (
  SELECT DISTINCT staff_id AS mod_id
    FROM reported_messages
    WHERE guild_id = '102860784329052160'
      AND staff_id IS NOT NULL
      AND staff_id != '984212151608705054'
      AND reason IN ('anonReport','track','spam','modResolution','automod')
      AND created_at BETWEEN '2025-12-04' AND '2026-02-21'
  UNION
  SELECT DISTINCT voter_id
    FROM escalation_records er
    JOIN escalations e ON e.id = er.escalation_id
    WHERE e.guild_id = '102860784329052160'
      AND er.voter_id != '984212151608705054'
);
```

Frame as "of active mods", not "of all mods on the team". Use `COUNT(DISTINCT voter_id)` always (vote-change rows are inserts, not updates).

#### CS4. Anonymous vs staff reports

```sql
SELECT reason,
       CASE WHEN staff_id IS NULL THEN 'anonymous' ELSE 'staff' END AS source,
       COUNT(*) AS n
FROM reported_messages
WHERE guild_id = '102860784329052160'
  AND reason IN ('anonReport','track','spam','modResolution','automod')
GROUP BY reason, source
ORDER BY reason, source;
```

Publish "anonReport" and "track" separately. Do NOT publish "2,053 staff-filed reports" — that lumps in 700 bot-written spam rows.

#### CS5. Reports → enforcement conversion (24h primary)

```sql
WITH eligible_reports AS (
  SELECT id, reported_user_id, reason, created_at
  FROM reported_messages
  WHERE guild_id = '102860784329052160'
    AND reason IN ('anonReport','track','spam','modResolution','automod')
    AND (extra IS NULL OR extra NOT LIKE 'Back-filled%')
    AND created_at >= '2026-02-20'  -- mod_actions ship date floor
)
SELECT reason,
       COUNT(*) AS n_reports,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM mod_actions ma
         WHERE ma.guild_id = '102860784329052160'
           AND ma.user_id = eligible_reports.reported_user_id
           AND julianday(ma.created_at) BETWEEN julianday(eligible_reports.created_at)
             AND julianday(eligible_reports.created_at) + 1
       ) THEN 1 ELSE 0 END) AS resolved_within_24h
FROM eligible_reports
GROUP BY reason;
```

Cohort floor: 2026-02-20 (mod_actions ship date). Lead with `anonReport` conversion (16.4%); avoid the overall % because it mixes structural categories.

#### CS6. Active mods over time (monthly)

```sql
WITH all_mod_activity AS (
  SELECT executor_id AS mod_id, strftime('%Y-%m', created_at) AS ym
    FROM mod_actions
    WHERE guild_id = '102860784329052160'
      AND executor_id IS NOT NULL
      AND executor_id != '984212151608705054'
  UNION ALL
  SELECT staff_id, strftime('%Y-%m', created_at)
    FROM reported_messages
    WHERE guild_id = '102860784329052160'
      AND staff_id IS NOT NULL
      AND staff_id != '984212151608705054'
      AND reason IN ('anonReport','track','spam','modResolution','automod')
  UNION ALL
  SELECT er.voter_id, strftime('%Y-%m', er.voted_at)
    FROM escalation_records er
    JOIN escalations e ON e.id = er.escalation_id
    WHERE e.guild_id = '102860784329052160'
      AND er.voter_id != '984212151608705054'
)
SELECT ym, COUNT(DISTINCT mod_id) AS active_mods
FROM all_mod_activity
GROUP BY ym ORDER BY ym;
```

Mark current month as MTD; do not publish current-month value standalone. Each contributing surface has its own ship date, so the time series widens monotonically — disclose if charted.

#### CS7. Messages tracked (community scale)

```sql
SELECT '30d' AS window,
       COUNT(*) AS messages
FROM message_stats
WHERE guild_id = '102860784329052160'
  AND sent_at >= (strftime('%s','now') - 30*86400) * 1000  -- ms epoch!
UNION ALL
SELECT '90d', COUNT(*) FROM message_stats
  WHERE guild_id='102860784329052160'
    AND sent_at >= (strftime('%s','now') - 90*86400) * 1000
UNION ALL
SELECT 'lifetime', COUNT(*) FROM message_stats
  WHERE guild_id='102860784329052160';

SELECT channel_category, COUNT(*) AS messages
FROM message_stats
WHERE guild_id='102860784329052160'
  AND sent_at >= (strftime('%s','now') - 30*86400) * 1000
GROUP BY channel_category
ORDER BY messages DESC LIMIT 5;
```

**Critical:** `sent_at` is unix MILLISECONDS, not seconds, not a datetime string. Mixing with `datetime('now')` arithmetic silently returns zero rows. Cohort start: 2024-10-08. Frame as "messages tracked", not "messages sent" (DELETE-on-delete trap).

---

### Funnel metrics — output: JSON snapshot for time-series diffing

For each funnel metric, the Phase 3 script must:
- Output JSON with `snapshot_date` as top-level key.
- Include every metric's current value; do NOT omit zero rows (they are the legitimate current state).
- Apply the cohort floor `created_at >= '2026-02-18'` for any metric anchored on `guild_subscriptions.created_at` (or `>= '2026-02-20'` if also gated on `mod_actions`).
- Honor optional `GTM_LAUNCH_DATE` env var: if set, emit a `since_gtm` view of each metric in addition to the standard view.
- Apply privacy contract: **aggregate-only**, no per-guild values, no IDs.

#### F1. Installs per week

```sql
SELECT strftime('%Y-W%W', created_at) AS week,
       COUNT(*) AS installs
FROM guild_subscriptions
WHERE created_at >= '2026-02-18'
GROUP BY week ORDER BY week;
```

Current: zero rows. Emit empty array in JSON. Meaningful when ≥ 4 weeks of post-GTM data.

#### F2. Trial → paid conversion

```sql
WITH cohorts AS (
  SELECT strftime('%Y-%m', created_at) AS install_month,
         product_tier,
         julianday('now') - julianday(created_at) AS days_since_install
  FROM guild_subscriptions
  WHERE created_at >= '2026-02-18'
)
SELECT install_month,
       COUNT(*) AS cohort_size,
       SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) AS converted,
       ROUND(100.0 * SUM(CASE WHEN product_tier='paid' THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct
FROM cohorts
WHERE days_since_install >= 90
GROUP BY install_month
HAVING cohort_size >= 5
ORDER BY install_month;
```

Current: zero rows. 90-day trial window per `stripe.server.ts:56`.

#### F3. TTFV (install → first mod_action)

```sql
WITH first_actions AS (
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
WHERE gs.created_at >= '2026-02-20';
```

Cohort floor 2026-02-20 (stricter of mod_actions ship + install corruption). Current: sample_n=0.

#### F4. Feature activation rate d7/d30

```sql
WITH cohort AS (
  SELECT gs.guild_id, gs.created_at AS installed_at,
         julianday('now') - julianday(gs.created_at) AS days_since_install
  FROM guild_subscriptions gs
  WHERE gs.created_at >= '2026-02-18'
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
       SUM(CASE WHEN days_since_install >= 7 THEN 1 ELSE 0 END) AS eligible,
       SUM(CASE WHEN days_since_install >= 7 AND has_modLog THEN 1 ELSE 0 END) AS modLog,
       SUM(CASE WHEN days_since_install >= 7 AND has_moderator THEN 1 ELSE 0 END) AS moderator,
       SUM(CASE WHEN days_since_install >= 7 AND has_deletionLog THEN 1 ELSE 0 END) AS deletionLog,
       SUM(CASE WHEN days_since_install >= 7 AND has_honeypot THEN 1 ELSE 0 END) AS honeypot,
       SUM(CASE WHEN days_since_install >= 7 AND has_reactji THEN 1 ELSE 0 END) AS reactji,
       SUM(CASE WHEN days_since_install >= 7 AND has_membergate THEN 1 ELSE 0 END) AS membergate
FROM feats
UNION ALL
SELECT 'd30',
       SUM(CASE WHEN days_since_install >= 30 THEN 1 ELSE 0 END),
       SUM(CASE WHEN days_since_install >= 30 AND has_modLog THEN 1 ELSE 0 END),
       SUM(CASE WHEN days_since_install >= 30 AND has_moderator THEN 1 ELSE 0 END),
       SUM(CASE WHEN days_since_install >= 30 AND has_deletionLog THEN 1 ELSE 0 END),
       SUM(CASE WHEN days_since_install >= 30 AND has_honeypot THEN 1 ELSE 0 END),
       SUM(CASE WHEN days_since_install >= 30 AND has_reactji THEN 1 ELSE 0 END),
       SUM(CASE WHEN days_since_install >= 30 AND has_membergate THEN 1 ELSE 0 END)
FROM feats;
```

Tickets omitted per indirect-measurement direction (`tickets_config` has no `guild_id`); report `(SELECT COUNT(*) FROM tickets_config)` as a lifetime aggregate alongside. Caveat (must include in JSON output): d7/d30 numbers are upper bounds because `*_config` tables lack activation timestamps.

#### F5. Retention (active in last 7/30d)

```sql
WITH cohort AS (
  SELECT gs.guild_id, strftime('%Y-%m', gs.created_at) AS install_month
  FROM guild_subscriptions gs
  WHERE gs.created_at >= '2026-02-20'  -- stricter floor
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
HAVING cohort_size >= 5;
```

"Active" = `mod_actions` only (narrow default). Current: zero rows.

#### F6. Churn snapshot

```sql
SELECT status, COUNT(*) AS cnt
FROM guild_subscriptions
GROUP BY status ORDER BY status;
```

**Note in JSON output:** this is a snapshot, not a flow. True churn rate requires `subscription_events`-style audit log (out of scope per user direction unless Q1 is Y).

---

### Validation script — output: Markdown report of cross-checks

The validation script implements one sanity check per headline metric. For each:

| Metric | Cross-check |
|---|---|
| CS1 spam events (30d) | `reported_messages WHERE reason='spam'` count matches `(reason='spam' AND extra NOT LIKE 'Back-filled%') + (reason='spam' AND extra LIKE 'Back-filled%')`. Reactiflux-specific back-fill % is small (≤ 1%); cross-guild back-fill % is ~13%. Flag if Reactiflux back-fill > 5%. |
| CS2 escalations resolved | `COUNT(*) WHERE resolved_at IS NOT NULL` matches `COUNT(*) WHERE resolution IS NOT NULL`. Flag any mismatch. |
| CS3 voters | `COUNT(DISTINCT voter_id)` ≤ `COUNT(*)` in `escalation_records`. Flag if equal (would mean no toggle/change patterns). |
| CS4 anonymity | `staff_id IS NULL AND reason='anonReport'` count matches the published anon-report number. Flag if any `reason='anonReport' AND staff_id IS NOT NULL` (would be a writer bug). |
| CS5 conversion | All eligible_reports's `reported_user_id` and matched mod_actions's `user_id` are non-null. Flag if any matches use the bot user ID as user_id (would be self-action leakage). |
| CS6 active mods | Bot ID `984212151608705054` does NOT appear in any active-mod month after exclusion. Flag if it does. |
| CS7 messages | `MIN(sent_at) <= MAX(sent_at)`, both within plausible Discord-epoch bounds (post-2015). Flag if pre-2015 (would suggest snowflake-decoded epoch math error). |
| Schema | `kysely_migration` count in prod backup is 29; matches the count in dev (or differs by exactly 1 if our deletion-log fix migration has shipped). Flag mismatch. |
| Corrupt rows | `reported_messages WHERE reason NOT IN ('anonReport','track','spam','modResolution','automod')` count is 82 (the known corrupt-row count). Flag if it grows (would mean new writes are landing in the bad path). |
| `deletion_log_threads` bug | Count of rows with `created_at = 'CURRENT_TIMESTAMP'` (before our fix migration ships, expect ~1606 in prod; after ship, expect 0). Flag if non-zero post-fix. |

Output: a Markdown table of `(check, expected, actual, status: OK | FLAG)` plus a summary line.

---

## Phase 3 implementation notes

**Conventions (from kickoff + existing `scripts/`):**

- TypeScript + Kysely. Use `node --experimental-strip-types scripts/<name>.ts` to run.
- Connect via `DATABASE_URL` env var (existing convention in `kysely.config.ts` and `Database.ts`).
- Print the database file path being read from (so it's unambiguous prod vs dev).
- **Refuse to run if `DATABASE_URL` is unset** — no silent fallback to a stale local DB.
- **Read-only.** Never issue `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ALTER`.
- Match the style of `scripts/dump-db-to-json.ts` and `scripts/seed-e2e.ts` for shape and imports.

**Scripts to produce:**

1. **`scripts/metrics-reactiflux-case-study.ts`** — one-shot. Runs CS1–CS7. Outputs Markdown to stdout (ready to paste into case-study page). Include `Generated: <ISO date>` and per-metric time window.
2. **`scripts/metrics-funnel-snapshot.ts`** — repeatable. Runs F1–F6. Outputs JSON to stdout with `snapshot_date` as top-level key + all metrics as siblings. Designed to be appended to a history file or diffed week-to-week.
3. **`scripts/metrics-validation.ts`** — runs all cross-checks from the validation table above. Outputs Markdown. Exit code 0 if all OK, 1 if any FLAG (so it can run in CI later).

**Output paths for first-run results:**

- Case-study script output → `notes/2026-05-12_3_case-study-report.md`
- Funnel snapshot → `notes/2026-05-12_4_funnel-snapshot.json`
- Validation report → `notes/2026-05-12_5_validation.md`

**The publishable Reactiflux numbers (lifted from the headline table) belong on a follow-up "what's publishable today vs what needs more time/data" report after Phase 3 runs.**

---

## Validation summary

| Item | Status |
|---|---|
| Every case-study source query runs cleanly against prod | ✅ |
| Every funnel source query runs cleanly against prod (returns empty/zero is OK) | ✅ |
| Cohort gates per metric documented | ✅ |
| Privacy filters applied (corrupt-row, bot-user, anonymity) | ✅ |
| Customer-facing copy avoids "wedge" jargon | ✅ |
| Open questions: 11 defaulted with reasoning, 2 surfaced to user | ✅ |
