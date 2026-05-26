# Phase 2 Spec: Reactiflux Case Study

**Date:** 2026-05-12
**Source DB:** `prod-mod-bot.sqlite3` backup (taken 2026-05-12 via `scripts/db-backup.sh`)
**Reactiflux guild ID:** `102860784329052160`
**Companion docs:** `notes/2026-05-11_4_metrics-inventory.md` (Phase 1 canonical reference)

Every query in this spec has been run against the snapshot above. Values reflect
the database state at backup time. All queries are read-only `SELECT`s. Privacy
contracts: no Discord IDs, no message content, no quoted free text in any
publishable artifact. Aggregate counts and timestamps only.

---

## Headline metrics summary table

| # | Metric | Value (today, Reactiflux) | Publishable? |
|---|---|---|---|
| 1 | Spam interruptions saved (30d) | 113 events → ~226 mod-minutes saved | Yes — exact or rounded |
| 1 | Spam interruptions saved (90d) | 247 events → ~494 mod-minutes saved | Yes — exact or rounded |
| 2 | Escalations initiated (lifetime since 2025-12-04) | 12 | Yes — small number, frame as "every escalation since launch" |
| 2 | Escalations resolved | 12 of 12 (100%) | Yes |
| 2 | Median time-to-resolution | ~30 hours (heavily influenced by scheduled deliberation windows) | Yes with caveat; prefer "unscheduled votes resolve in 3–16 hours" framing |
| 3 | Distinct voters total | 5 across 10 escalations with at least one vote | Yes — count only |
| 3 | Voter participation rate | 5 / 20 eligible mods = 25% | Yes |
| 4 | Anonymous reports filed (lifetime) | 629 | Yes |
| 4 | Staff reports filed (lifetime) | 1,353 (track) + 700 (auto-spam, bot-written) = 2,053 | Yes — but split them; "staff track reports" is the clean number |
| 5 | Report → enforcement conversion (24h, all reasons) | 52 / 463 = 11.2% (post-2026-02-20 cohort) | Yes with cohort disclosure |
| 5 | Report → enforcement (anonReport, 24h) | 21 / 128 = 16.4% | Yes |
| 6 | Active mods (peak month, Jan 2026) | 18 distinct mods | Yes |
| 6 | Active mods (current month-to-date, May 2026) | 6 (partial month) | Yes with "month-to-date" caveat |
| 7 | Messages tracked, last 30d | 31,689 | Yes |
| 7 | Messages tracked, last 90d | 89,503 | Yes |
| 7 | Messages tracked, lifetime (since 2024-10-08) | 828,589 | Yes — "more than 800,000" |

---

## Per-metric specs

### 1. Spam interruptions saved

**Definition.** Count of unique spam events auto-handled by the bot in a given
time window, multiplied by 2 minutes per event. Frame as "mod interruptions
saved" — the time a moderator would otherwise have spent context-switching to
verify and remove a spam message. **Do not call this "mod-hours saved"** (the
user explicitly rejected that framing).

**Audience.** Case study (Reactiflux).

**Source query.**

```sql
SELECT
  COUNT(*) AS spam_events,
  COUNT(*) * 2 AS minutes_saved
FROM reported_messages
WHERE guild_id = '102860784329052160'
  AND reason = 'spam'
  AND (extra IS NULL OR extra NOT LIKE 'Back-filled%')
  AND created_at >= datetime('now', '-30 days'); -- swap '-90 days' for 90d window
```

Citation: `notes/2026-05-11_4_metrics-inventory.md` lines 31, 287–303 (the
`reported_messages` per-table reference, including the spam back-fill trap and
the bot-as-staff_id contract for spam writes).

**Caveats.**

- **Back-fill exclusion is mandatory.** The spam-detection writer back-fills
  prior duplicate messages from the same user when it detects spam
  (`spamResponseHandler.ts:278`). One detected event yields multiple rows. Filter
  `extra NOT LIKE 'Back-filled%'` to count unique events. In Reactiflux the
  back-fill rate is small (3 of 703 rows = 0.4%) but the filter is binding.
- **Cohort gate: 2025-07-26.** `reported_messages` shipped on that date. No
  spam data before then.
- **Corrupt-row filter not strictly needed for this query** because the 82
  corrupt rows in the wider table have non-enum `reason` values (`'0'`–`'55'`)
  and would never match `reason='spam'`. But other queries on this table must
  filter `reason IN (...)` defensively.
- **"2 minutes per interruption" is a defensible assumption, not a measurement.**
  Frame as "estimated" in any customer-facing copy. The user owns the
  multiplier; flag for confirmation if it ever changes.
- The bot writes spam rows with `staff_id = bot_user_id`, not NULL. Do not
  use `staff_id IS NULL` to identify auto-handled spam (see inventory trap 3
  and `notes/2026-05-11_4_metrics-inventory.md` lines 296–303).

**Validation method.** Cross-checked against `mod_actions` automod-timeout count
(executor_id IS NULL, action_type='timeout') in the same windows: **14 automod
timeouts in last 30d, 40 in last 90d**. These do NOT match the spam-event count
1:1 because Discord-native automod (triggered by guild-configured rules) and
the bot's in-app spam detector are separate surfaces — the bot's spam detector
deletes messages and writes `reported_messages` rows but does NOT trigger a
Discord timeout. So the two counts measure different things; the order of
magnitude (tens vs hundreds) is correct and consistent with the bot's spam
detector being the dominant signal.

**Numbers as of 2026-05-12 backup:**

- Lifetime unique spam events (Reactiflux): **700**
- Last 30 days: **113 events → 226 minutes saved**
- Last 90 days: **247 events → 494 minutes saved**

**Publishability.** Yes. Recommended forms:

- Raw count + minutes: "In the last 30 days, Euno auto-handled 113 spam
  incidents in Reactiflux — roughly 226 minutes of moderator interruption
  avoided."
- Round if preferred: "more than 100 spam incidents auto-handled in the last
  month" / "nearly 500 minutes of mod interruption saved in the last quarter".

**Customer-facing copy framing.** "Euno's spam detection has auto-handled more
than 100 incidents in Reactiflux over the last 30 days — that's roughly 4 hours
of moderator interruption avoided each month."

---

### 2. Escalations: initiated, resolved, average time-to-resolution

**Definition.** Three sub-metrics from `escalations`:

- **Initiated** — count of rows.
- **Resolved** — count where `resolved_at IS NOT NULL`.
- **Time-to-resolution** — `resolved_at - created_at`, reported with breakdown
  by resolution value and by scheduled vs. unscheduled.

**Audience.** Case study (Reactiflux).

**Source query.**

```sql
-- Initiated / resolved counts
SELECT
  COUNT(*) AS initiated,
  SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
FROM escalations
WHERE guild_id = '102860784329052160';

-- Breakdown by resolution
SELECT
  resolution,
  COUNT(*) AS n,
  ROUND(AVG((julianday(resolved_at) - julianday(created_at)) * 24 * 60), 1)
    AS avg_min,
  ROUND(MIN((julianday(resolved_at) - julianday(created_at)) * 24 * 60), 1)
    AS min_min,
  ROUND(MAX((julianday(resolved_at) - julianday(created_at)) * 24 * 60), 1)
    AS max_min
FROM escalations
WHERE guild_id = '102860784329052160' AND resolved_at IS NOT NULL
GROUP BY resolution;

-- Scheduled vs unscheduled split (since most escalations have a future
-- scheduled_for that dominates wall-clock resolution time)
SELECT
  CASE
    WHEN scheduled_for IS NULL OR scheduled_for = ''
      THEN 'unscheduled (default 15min)'
    ELSE 'scheduled'
  END AS bucket,
  COUNT(*) AS n,
  ROUND(AVG((julianday(resolved_at) - julianday(created_at)) * 24 * 60), 1)
    AS avg_min_from_create
FROM escalations
WHERE guild_id = '102860784329052160' AND resolved_at IS NOT NULL
GROUP BY bucket;
```

Citation: `notes/2026-05-11_4_metrics-inventory.md` lines 169–179 (escalations
table reference, including the `resolution='track'` overload trap and the
15-min default resolver behavior).

**Caveats.**

- **Cohort gate: 2025-11-28.** No escalations before then.
- **`resolution='track'` is overloaded.** Per the inventory's trap #2, `track`
  collapses three distinct outcomes: explicit "track" vote, zero votes
  (timed out with no participation), and "user left before resolve". The
  per-escalation voter-count query distinguishes the second case (zero
  voters); the third would require Discord-side log inspection.
- **Time-to-resolution is dominated by `scheduled_for`.** 9 of 12 Reactiflux
  escalations had a `scheduled_for` value set 1+ days in the future (these are
  deliberate delays to allow mod discussion, not delays in the system). Report
  the scheduled/unscheduled split, not just one average.
- **Sample size is small (n=12).** Frame any time-to-resolve number as
  illustrative; do not publish a precise average without the n.
- **Tied votes resolve by severity, not consensus** (inventory trap #2 again).
  Don't report "consensus rate" from this table without `escalation_records`
  detail.

**Validation method.** Spot-checked individual escalation rows for internal
consistency: `resolved_at >= created_at` in all 12 rows; `resolution` ∈
{track, ban, kick, restrict} matches the documented application enum; 12 of 12
rows have `resolved_at` (no open escalations in the snapshot). Sub-counts by
resolution sum to total (8+2+1+1=12). Three rows resolved on the same day
(2025-12-20) — confirms the 15-min poll loop sweeping a backlog.

**Numbers as of 2026-05-12 backup:**

- Initiated: **12** (since 2025-12-04)
- Resolved: **12** (100% closure rate; no open escalations in snapshot)
- Resolution breakdown: track 8, ban 2, kick 1, restrict 1
- Avg minutes to resolve (raw, all 12): 4,857 min ≈ 81 hours
- Median: ~30 hours (between rows 6 and 7 in sorted order)
- Scheduled escalations (9 of 12): avg 6,296 min ≈ 105 hours from creation
- Unscheduled escalations (3 of 12): avg 540 min ≈ 9 hours from creation
- Unscheduled range: **172 min (~2.9h) → 966 min (~16h)**

**Publishability.** Yes, with care:

- "Escalations initiated since launch: 12" — fine.
- "100% of escalations reached resolution" — fine.
- Time-to-resolution: **use the unscheduled bucket** ("escalations without a
  scheduled deliberation window resolve in 3 to 16 hours") rather than the
  overall average — that's the number readers will pattern-match against
  "how fast does the system work".

**Customer-facing copy framing.** "Since Reactiflux turned on escalation voting,
every one of their 12 escalations has reached resolution — typically within a
day for fast-track cases, with extended deliberation windows used when the
team chose to take more time."

---

### 3. Voter participation rate per escalation

**Definition.** Distinct mods who voted on each escalation, expressed both as
a raw count and as a percentage of "eligible mods" — mods who were active in
the bot during the escalation window.

**Audience.** Case study (Reactiflux).

**Source query.**

```sql
-- Distinct voters per escalation (uses COUNT DISTINCT to handle vote-change
-- duplicate rows per inventory trap)
SELECT
  e.id,
  COUNT(DISTINCT er.voter_id) AS distinct_voters
FROM escalations e
LEFT JOIN escalation_records er ON er.escalation_id = e.id
WHERE e.guild_id = '102860784329052160'
GROUP BY e.id;

-- Aggregate: avg/min/max voters per escalation
WITH per_esc AS (
  SELECT COUNT(DISTINCT er.voter_id) AS v
  FROM escalations e
  LEFT JOIN escalation_records er ON er.escalation_id = e.id
  WHERE e.guild_id = '102860784329052160'
  GROUP BY e.id
)
SELECT AVG(v) AS avg_voters_per_esc, MIN(v), MAX(v) FROM per_esc;

-- Eligible-mod denominator: distinct mods active on any bot surface during
-- the escalation window (2025-12-04 to 2026-02-21), excluding the bot user
-- (984212151608705054 — identified empirically as the spam-row staff_id).
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
      AND voter_id != '984212151608705054'
);
```

Citation: `notes/2026-05-11_4_metrics-inventory.md` lines 180–188 (escalation_records reference and the COUNT(DISTINCT voter_id) requirement); lines 31–34 (trap #4 on COUNT DISTINCT for vote changes).

**Eligible-mod denominator — the defensible definition.**

The inventory's Phase 2 follow-up #6 specifically calls out that the "active
mod" set must be defined. For *this metric* the right denominator is "mods who
demonstrably had access to the bot during the escalation window", which I
operationalize as:

> Distinct user IDs that appear as `staff_id` in `reported_messages` OR
> `voter_id` in `escalation_records` for Reactiflux during the escalation
> window (2025-12-04 to 2026-02-21), excluding the bot user.

I do **not** use `mod_actions.executor_id` in this denominator because
`mod_actions` only shipped 2026-02-20 — the same date as the last Reactiflux
escalation — so it cannot represent the full window. For metric 6 (active mod
count over time), the denominator does include `mod_actions` rows in their
valid date range.

**Caveats.**

- **`COUNT(DISTINCT voter_id)` is mandatory.** Vote changes are new
  `escalation_records` inserts, so a voter who changed their mind has
  multiple rows (inventory trap, secondary item #4).
- **Toggle-off deletes the row.** A mod who voted then withdrew leaves no
  trace; this metric undercounts participation by an unknown amount.
- **Denominator is approximate.** It's "mods who used the bot during the
  window", not "mods on the Reactiflux mod team roster" — the latter would
  require Discord role-membership inspection which we cannot do from SQL
  alone. Frame the percentage as "of active mods", not "of all mods".
- **Bot-user exclusion is critical.** The bot user ID
  (`984212151608705054`, identified empirically because it accounts for all
  700 `reason='spam'` rows) must be filtered from any "distinct mods" union.
- **Small n.** 12 escalations and 5 distinct voters is a small sample; the
  number is honest but its precision is limited.

**Validation method.** Cross-checked the eligible-mod count two ways: (a)
union of staff reporters + voters during the window = 20; (b) staff reporters
alone in window = 20. The voters are a subset of the staff-reporter set,
which is internally consistent (anyone voting on an escalation is by
definition a moderator with bot access during the window). Also confirmed
bot-user exclusion: bot ID appears zero times in `mod_actions.executor_id`,
zero times in `escalation_records.voter_id`, zero times as `track` reporter.
It only appears as the synthetic `staff_id` on spam writes.

**Numbers as of 2026-05-12 backup:**

- Distinct voters across all escalations: **5**
- Distinct voters per escalation: **min 0, max 3, mean 1.58**
- Escalations with zero voters: **2 of 12** (these resolved to `track`
  by timeout, not consensus — distinguishes the overloaded `resolution='track'`
  case)
- Eligible mods during escalation window: **20**
- Participation rate: **5 / 20 = 25%** of active mods cast at least one
  escalation vote during the window

**Publishability.** Yes. Recommended forms:

- "5 distinct moderators cast votes across 12 escalations" — direct.
- "25% of active Reactiflux moderators participated in at least one escalation
  vote" — directional but defensible.
- Avoid framing as "the consensus rate" — votes are not consensus
  measurements per the tied-vote trap.

**Customer-facing copy framing.** "Escalation voting in Reactiflux drew
participation from a quarter of their active moderators — democratizing
decisions that used to fall on whoever was online."

---

### 4. Anonymous vs staff reports filed

**Definition.** Count of reports filed against messages, split by who filed
them: anonymous community members (`staff_id IS NULL`) versus identified
staff (`staff_id IS NOT NULL` and `reason='track'`).

**Audience.** Case study (Reactiflux).

**Source query.**

```sql
SELECT
  reason,
  CASE WHEN staff_id IS NULL THEN 'anonymous' ELSE 'staff' END AS source,
  COUNT(*) AS n
FROM reported_messages
WHERE guild_id = '102860784329052160'
  AND reason IN ('anonReport','track','spam','modResolution','automod')
GROUP BY reason, source
ORDER BY reason, source;
```

Citation: `notes/2026-05-11_4_metrics-inventory.md` lines 285–303
(reported_messages reference, especially the staff_id-NULL anonymity contract
on line 294 / inventory trap #3) and line 38 (corrupt-row filter).

**Caveats.**

- **`staff_id IS NULL` is the binding anonymity contract.** Never join those
  rows to any user-identifying source in published output.
- **Spam rows look "staffed" but aren't.** All 703 `reason='spam'` rows have
  `staff_id` set to the bot user — these are bot-written, not staff-written.
  To get a clean "manually filed staff reports" number, use
  `reason='track'` only.
- **Corrupt-row filter is mandatory.** 82 rows in the wider production table
  have non-enum `reason` values and `created_at = '[]'`. The `reason IN (...)`
  filter excludes them. Without it, table-level counts overstate by exactly 82.
- **Cohort gate: 2025-07-26.** No data before then.
- **`reason='modResolution'` and `reason='automod'`** are enum values with no
  observed writer path (inventory follow-up #2). In the Reactiflux subset they
  have zero rows. Safe to include in the filter; they contribute nothing.

**Validation method.** Sums match the kickoff-provided validated facts exactly
(anonReport 629, track 1353, spam 703). The 3 spam-anon rows discovered in
this snapshot (vs. the kickoff's stated `700 staff / 3 anon` split for spam)
are likely the historical leakage referenced in inventory trap secondary
item #3 — confirms the inventory's note that spam writes *normally* set
`staff_id` to the bot but a handful of older rows exist with NULL.

**Numbers as of 2026-05-12 backup (Reactiflux, lifetime):**

- Anonymous reports (`anonReport`, staff_id NULL): **629**
- Staff "track" reports (`track`, staff_id NOT NULL): **1,353**
- Spam reports written by bot (`spam`, staff_id = bot): **700**
- Spam reports with NULL staff_id (rare anomaly): **3**

Last 30 days breakdown:

- Anonymous: **46**
- Staff track: **27**
- Bot-written spam (excl. back-fill): **113**

Last 90 days breakdown:

- Anonymous: **161**
- Staff track: **126**
- Bot-written spam (excl. back-fill): **247**

**Publishability.** Yes. Strongly recommended split:

- Headline: "Anonymous reports filed in Reactiflux: 629" + "Staff-filed track
  reports: 1,353".
- Do NOT publish "2,053 staff-filed reports" — that includes 700 bot-written
  rows and is misleading.
- The 30-day anon-vs-track ratio is interesting (46 anon vs. 27 staff =
  ~63% of recent reports came from the community via anonymous reporting).

**Customer-facing copy framing.** "Reactiflux community members have filed
more than 600 anonymous reports through Euno — feedback that would never have
reached the mod team otherwise."

---

### 5. Reports → enforcement action conversion rate

**Definition.** Of reports filed, what fraction lead to a recorded
`mod_action` against the same `reported_user_id` within a defined time window
(24 hours and 7 days), restricted to the cohort of reports filed on or after
2026-02-20 (when `mod_actions` shipped).

**Audience.** Case study (Reactiflux).

**Source query.**

```sql
WITH eligible_reports AS (
  SELECT id, reported_user_id, reason, created_at
  FROM reported_messages
  WHERE guild_id = '102860784329052160'
    AND reason IN ('anonReport','track','spam','modResolution','automod')
    AND (extra IS NULL OR extra NOT LIKE 'Back-filled%')
    AND created_at >= '2026-02-20'  -- cohort gate
)
SELECT
  reason,
  COUNT(*) AS n_reports,
  SUM(CASE WHEN EXISTS (
    SELECT 1 FROM mod_actions ma
    WHERE ma.guild_id = '102860784329052160'
      AND ma.user_id = eligible_reports.reported_user_id
      AND julianday(ma.created_at) BETWEEN julianday(eligible_reports.created_at)
        AND julianday(eligible_reports.created_at) + 1
  ) THEN 1 ELSE 0 END) AS resolved_within_24h,
  SUM(CASE WHEN EXISTS (
    SELECT 1 FROM mod_actions ma
    WHERE ma.guild_id = '102860784329052160'
      AND ma.user_id = eligible_reports.reported_user_id
      AND julianday(ma.created_at) BETWEEN julianday(eligible_reports.created_at)
        AND julianday(eligible_reports.created_at) + 7
  ) THEN 1 ELSE 0 END) AS resolved_within_7d
FROM eligible_reports
GROUP BY reason;
```

Citation: `notes/2026-05-11_4_metrics-inventory.md` lines 260–273 (mod_actions
ship date 2026-02-20, no backfill) and lines 285–303 (reported_messages
back-fill filter).

**Window decision: 24h primary, 7d secondary.** 24 hours is the natural mod
SLA window for active-spam cases; 7 days captures longer-tail follow-up
where a mod returns to enforce after off-time. Report both; lead with 24h.

**Caveats.**

- **Strict cohort gate at 2026-02-20.** Reports filed before that date
  cannot resolve to `mod_actions` because the table didn't exist. The query
  applies this gate explicitly. **Do not retroactively measure pre-cohort
  conversion** — the number would be artificially zero.
- **Bot self-actions are excluded from `mod_actions`** (inventory trap #2).
  The in-app spam detector deletes messages WITHOUT writing a `mod_action`
  row, so spam reports have a structurally lower conversion rate than
  staff-filed reports — the spam *report* is itself the enforcement act for
  most spam, and only "real" follow-up enforcement (a ban for the same user
  later) shows up here. Frame this honestly: spam conversion is a measure of
  human escalation, not initial enforcement.
- **Discord-native automod timeouts DO appear in `mod_actions`** with
  `executor_id IS NULL`. They count toward conversion. That's correct
  behavior; just be aware of it.
- **Same-user join across tables.** Both `reported_messages.reported_user_id`
  and `mod_actions.user_id` are Discord snowflakes (per inventory trap #4 —
  they do NOT go through `users.id`). Direct join is correct.
- **Back-fill rows excluded** to keep the denominator's spam count to unique
  events.
- **Conversion ≠ correctness.** A non-converted report may still have been a
  legitimate complaint that was handled informally. Don't frame the
  inverse as "false-report rate".

**Validation method.** Cross-checked the cohort gate: zero reports before
2026-02-20 produced a `mod_action` lookup hit in the test query (because the
table is empty there). Confirmed the 24h-window numerator is always ≤ the 7d
numerator (monotonic — sanity passes). Distinct numerators show expected
ordering: anonymous reports have higher conversion (16.4%) than staff-track
reports (7.5%), consistent with anon reports being filed against more
clear-cut cases.

**Numbers as of 2026-05-12 backup (post-2026-02-20 cohort):**

| Reason | n reports | Action in 24h | Action in 7d |
|---|---|---|---|
| anonReport | 128 | 21 (16.4%) | 24 (18.8%) |
| spam | 229 | 23 (10.0%) | 24 (10.5%) |
| track | 106 | 8 (7.5%) | 11 (10.4%) |
| **Total** | **463** | **52 (11.2%)** | **59 (12.7%)** |

**Publishability.** Yes, with the cohort window clearly stated.

- Lead with the anonymous-report conversion: "16% of anonymous community
  reports lead to formal moderation action within 24 hours."
- Avoid the overall % without context — the spam-report row pulls the
  average down for a structural reason (bot self-action exclusion) that the
  reader won't know about.

**Customer-facing copy framing.** "Roughly one in six anonymous reports
filed through Euno result in formal moderation action within 24 hours —
giving Reactiflux's community a direct line to the moderation team that
doesn't depend on knowing who to DM."

---

### 6. Active mod count over time

**Definition.** Distinct moderators with at least one bot-surface action in a
calendar month — where "action" is the union of: executor of a `mod_action`,
staff_id on a `reported_messages` row (any non-spam reason, plus
non-bot-authored spam rows), or voter on an `escalation_record`.

**Audience.** Case study (Reactiflux).

**Source query.**

```sql
WITH all_mod_activity AS (
  -- Mod actions executors (since 2026-02-20)
  SELECT executor_id AS mod_id, strftime('%Y-%m', created_at) AS ym
    FROM mod_actions
    WHERE guild_id = '102860784329052160'
      AND executor_id IS NOT NULL
      AND executor_id != '984212151608705054'  -- exclude bot
  UNION ALL
  -- Staff reporters (since 2025-07-26); bot is excluded.
  -- IMPORTANT: corrupt-row filter via reason IN (...).
  SELECT staff_id, strftime('%Y-%m', created_at)
    FROM reported_messages
    WHERE guild_id = '102860784329052160'
      AND staff_id IS NOT NULL
      AND staff_id != '984212151608705054'
      AND reason IN ('anonReport','track','spam','modResolution','automod')
  UNION ALL
  -- Escalation voters (since 2025-11-28)
  SELECT voter_id, strftime('%Y-%m', voted_at)
    FROM escalation_records er
    JOIN escalations e ON e.id = er.escalation_id
    WHERE e.guild_id = '102860784329052160'
      AND voter_id != '984212151608705054'
)
SELECT ym, COUNT(DISTINCT mod_id) AS active_mods
FROM all_mod_activity
GROUP BY ym
ORDER BY ym;
```

Citation: `notes/2026-05-11_4_metrics-inventory.md` lines 19–28 (the five
traps — especially the bot self-action filter, the anonymity contract, and
the corrupt-row gate) plus Phase 2 follow-up #6 (line 361) which explicitly
calls out defining the "active mod" set as a union of the three surfaces.

**Caveats.**

- **Each contributing surface has its own cohort start date.** A mod's
  earliest possible "active month" is bounded by the earliest surface they
  use — so the time series widens as new tables ship. May 2026 numbers
  reflect all three sources; July 2025 reflects only `reported_messages`.
  This is honest but worth disclosing in any time-series chart.
- **Bot user must be excluded.** The bot's `staff_id` appears on all 700
  spam rows; including it inflates every month by 1. Filter the bot ID
  explicitly.
- **Corrupt-row filter binding** for the `reported_messages` UNION leg.
- **Anonymous reports do NOT contribute to this count** — `staff_id IS NULL`
  filter on the staff-reporters leg.
- **"Active" here means used-the-bot, not "active on the Discord server".**
  A mod who moderated entirely outside Euno that month is invisible.
- **Current month is partial.** May 2026 number is month-to-date; do not
  publish it as if it's a complete month.

**Validation method.** Spot-checked individual months: 18 active in Jan 2026
matches the expectation set by the escalation-window denominator (20 active
across Dec 2025–Feb 2026). Confirmed bot exclusion: with the bot included,
every month's count rose by exactly 1, which is the expected signature of a
single ID appearing in every month. Confirmed the corrupt-row filter
exclusion doesn't change monthly counts (corrupt rows have
`created_at='[]'` which `strftime` returns as NULL, naturally bucketed out).

**Numbers as of 2026-05-12 backup (Reactiflux, monthly distinct active mods,
bot excluded):**

| Month | Active mods |
|---|---|
| 2025-07 | 5 |
| 2025-08 | 15 |
| 2025-09 | 13 |
| 2025-10 | 17 |
| 2025-11 | 16 |
| 2025-12 | 13 |
| 2026-01 | 18 |
| 2026-02 | 17 |
| 2026-03 | 11 |
| 2026-04 | 8 |
| 2026-05 (MTD) | 6 |

**Publishability.** Yes. Recommended forms:

- "Reactiflux has had 13–18 moderators active in Euno each month since
  August 2025."
- "Peak active-mod month: 18 mods in January 2026."
- Avoid publishing the May 2026 number alone — it's a partial month.

**Customer-facing copy framing.** "On any given month, more than a dozen
Reactiflux moderators use Euno to handle reports, vote on escalations, or
take action — moderation as team sport, not solo performance."

---

### 7. Headline volume (messages tracked)

**Definition.** Count of messages whose stats are captured in `message_stats`
for Reactiflux, plus the top channel categories by volume.

**Audience.** Case study (Reactiflux).

**Source query.**

```sql
-- Volume totals
SELECT
  '30d'  AS window,
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

-- Top channel categories last 30d (uses denormalized channel_category column
-- on message_stats — preferable to joining channel_info because the
-- denormalized column has no NULLs).
SELECT channel_category, COUNT(*) AS messages
FROM message_stats
WHERE guild_id='102860784329052160'
  AND sent_at >= (strftime('%s','now') - 30*86400) * 1000
GROUP BY channel_category
ORDER BY messages DESC
LIMIT 5;
```

Citation: `notes/2026-05-11_4_metrics-inventory.md` lines 242–258 (message_stats
reference, including the trap that `sent_at` is unix milliseconds — line 251
and trap #1 line 19 on the DELETE-on-MessageDelete behavior).

**Caveats.**

- **`sent_at` is unix milliseconds, not a datetime string.** All
  comparisons must multiply the epoch seconds by 1000 (`* 1000`). Mixing this
  with `datetime('now', '-30 days')` will silently produce zero rows.
- **Trap #1: this table DELETES rows on Discord MessageDelete.** Counts
  represent "messages currently retained", not "all messages ever sent".
  Spam deletions in particular remove rows. The undercount is small relative
  to total volume but is *non-zero* — frame the number as "messages tracked"
  or "messages observed", never "messages sent".
- **`analytics` flag gated.** Reactiflux is the canonical guild with the
  flag enabled. Cross-guild headline numbers from this table would be
  unrepresentative; case-study use is fine.
- **Cohort start: 2024-10-08** (earliest `sent_at` in Reactiflux).
- **Channel categories include Discord-public names** (e.g., "Need Help",
  "React General"). These are public-facing in Reactiflux so OK to publish;
  in any other guild they'd be PII-id-adjacent.
- **`channel_category` on `message_stats` is denormalized at write time.**
  If a channel is renamed or recategorized after a row is written, the row
  retains the old category. Acceptable for volume snapshots; flag if
  building a "current state" view.

**Validation method.** Cross-checked the top-categories query two ways:
(a) joining `channel_info`, (b) using the denormalized `channel_category`
column. Both produced identical top-5 results, confirming the denormalized
column is reliable (and faster). Date range from `MIN/MAX(sent_at)` shows
2024-10-08 → 2026-05-12, consistent with the inventory's ship date.

**Numbers as of 2026-05-12 backup (Reactiflux):**

- Last 30 days: **31,689 messages**
- Last 90 days: **89,503 messages**
- Lifetime (since 2024-10-08): **828,589 messages**

Top channel categories last 30 days:

| Category | Messages (30d) |
|---|---|
| Social | 23,675 |
| Community | 3,239 |
| Need Help | 1,737 |
| Reactiflux | 1,005 |
| React General | 964 |

Top channel categories last 90 days:

| Category | Messages (90d) |
|---|---|
| Social | 61,341 |
| Community | 12,218 |
| Reactiflux | 5,244 |
| Need Help | 5,228 |
| React General | 2,377 |

**Publishability.** Yes. Recommended forms:

- "More than 800,000 messages tracked in Reactiflux since October 2024."
- "Roughly 30,000 messages per month tracked across the community."
- Channel breakdown is fine to publish for Reactiflux specifically.
  Frame as "scale of the community" — the volume isn't a feature, it's
  context for everything else.

**Customer-facing copy framing.** "Euno has tracked more than 800,000
messages across Reactiflux — the scale at which spam detection, escalation
voting, and anonymous reporting actually need to operate."

---

## Open questions for the user

1. **"2 minutes per spam interruption" multiplier.** I treated this as fixed
   per the kickoff direction. If the GTM team wants to use a different
   assumption (1.5 min, 3 min, etc.), it's a one-line change in the script.
   Confirm before publication.

2. **Conversion-rate window: 24h or 7d as the headline?** I lead with 24h in
   the copy framing for `anonReport` because it produces the cleaner
   "16% within a day" narrative; 7d adds only marginal lift (16.4% → 18.8%).
   Confirm the 24h framing.

3. **Reactiflux mod team roster size.** For metric 3 (voter participation
   rate), my denominator is "mods who used the bot during the escalation
   window" = 20. If the actual mod team is bigger (e.g., 30 mods on the
   Discord role), the 25% participation rate is an upper bound. If the
   user can provide the roster size, I can re-anchor the percentage to
   "of all mods" (more conservative, more defensible). Otherwise we publish
   "of active mods" as written.

4. **Escalation time-to-resolution: which framing to lead with?** The raw
   mean (~81h) is bad copy. The unscheduled subset (3–16h, n=3) is small.
   The 100% resolution rate is strong copy. My recommendation is to lead
   with "100% of escalations reached resolution" and only mention timing
   if pressed (because the small n on unscheduled votes makes any time
   number fragile). Confirm.

5. **May 2026 month-to-date suppression.** I'd recommend the active-mods
   chart stop at April 2026 to avoid a misleading partial-month dip in
   May. If the case study is publish-ready before end of May, the chart
   should be relabeled or the partial month dropped entirely. Confirm
   the publish date so I can pick the right approach.

6. **Backfill rate inconsistency.** Inventory says ~13% of spam rows
   globally are back-fills; Reactiflux specifically is 0.4% (3/703). Worth
   sanity-checking against the broader dataset before publication — if
   the 13% number is real elsewhere, it suggests our spam detection
   behaves materially differently on Reactiflux than on other guilds
   (possibly because Reactiflux gets less repeat-spammer activity). Not a
   blocker for the case study, but a flag.

7. **Anomaly: 3 spam rows with `staff_id IS NULL`.** The inventory implies
   all spam rows should have the bot's staff_id. 3 rows in prod don't.
   Likely historical leakage from before the writer set staff_id
   explicitly. Worth a one-line investigation in the writer code path but
   doesn't materially affect any of these metrics.
