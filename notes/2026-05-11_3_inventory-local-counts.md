# Local DB Inventory — Empirical Sanity Check

**Scope:** local dev DB at `/Users/vcarl/workspace/mod-bot/mod-bot.sqlite3` as of **2026-05-11**.
**Author:** Phase 1 Agent C (metrics research).
**Companion docs:** Agent A (schema definitions / migrations) and Agent B (writer paths).

**Caveat (read first):** every observation below is from the local dev DB, not production. The dev DB has only 2 guilds and tiny row counts; anything described as "always null" or "always populated" here is a yellow flag that needs to be re-checked once the prod backup lands. Do **not** publish anything from this document.

---

## Headline counts (all tables)

| Table                       | Rows |
|-----------------------------|------|
| application_config          | 2    |
| applications                | 18   |
| background_jobs             | 4    |
| channel_info                | **0** |
| deletion_log_threads        | 2    |
| escalation_records          | **0** |
| escalations                 | **0** |
| guild_subscriptions         | 2    |
| guilds                      | 2    |
| honeypot_config             | 3    |
| kysely_migration            | 29   |
| kysely_migration_lock       | 1    |
| message_cache               | **0** |
| message_stats               | **0** |
| mod_actions                 | 3    |
| reactji_channeler_config    | **0** |
| reported_messages           | 12   |
| sessions                    | **0** |
| tickets_config              | 7    |
| user_threads                | 5    |
| users                       | **0** |

Distinct `guild_id` values across populated tables: **2** in every guild-scoped table that has rows (consistent — dev DB only exercises two guilds).

---

## Empty tables (CANNOT sanity-check locally — need prod backup)

These tables have **zero rows in dev**. The features they support either ship sparse data, are gated to specific guilds, or aren't exercised by the dev workflow. Each is a blocker for any metric derived from it until prod data is available.

- **`channel_info`** — channel catalog. Empty in dev; presumably populated by activity tracker or onboarding. May be entirely a prod-only table.
- **`escalations`** — load-bearing for GTM (democratic moderation = the wedge). **Zero rows in dev.** All escalation metrics are unverifiable locally.
- **`escalation_records`** — vote records per escalation. Empty (consistent with `escalations` being empty).
- **`message_cache`** — short-lived message store. Likely TTL-pruned. Empty in dev — possible the dev bot doesn't run the cache writer, or the prune sweeps it.
- **`message_stats`** — activity tracking source data. Empty in dev. If this is empty in prod too, "active mod count over time" and other activity-derived metrics aren't reachable.
- **`reactji_channeler_config`** — reactji channeler feature configuration. No dev guilds use it.
- **`sessions`** — web auth sessions. Empty makes sense for a dev install with no recent web logins.
- **`users`** — web-auth user records. Empty for same reason as `sessions`. **Note:** Discord user IDs are stored inline in other tables (e.g. `mod_actions.user_id`, `reported_messages.staff_id`) — this table only holds web-app accounts.

GTM impact: the empty-in-dev set includes **the entire escalation pipeline** (`escalations` + `escalation_records`) and **the activity surface** (`message_stats`, `message_cache`, `channel_info`). Those are the most important tables for the case study; expect to lean on the prod backup heavily.

---

## Per-table breakdown (populated tables only)

### `application_config`
- **Rows:** 2 (one per onboarded guild).
- **Distinct guilds:** 2.
- All columns are NOT NULL in schema; nothing nullable to check.
- **Observation:** 1:1 with the two guilds present. Consistent.

### `applications`
- **Rows:** 18.
- **Time range (created_at):** 2026-03-20 → 2026-03-25 (5-day burst, then silent).
- **Distinct guilds:** 2.

| Column              | Null in dev | % populated |
|---------------------|------------|-------------|
| log_message_id      | 3 / 18     | 83%         |
| resolved_at         | 0 / 18     | 100%        |
| review_message_id   | 6 / 18     | 67%         |
| reviewed_by         | 0 / 18     | 100%        |

- `resolved_at` and `reviewed_by` are **schema-nullable but 100% populated in dev** — every application row has been resolved. Possibly because dev rows were seeded/processed in bulk. In prod, expect to see in-flight (unresolved) rows.
- `review_message_id` null in 6/18 rows: appears tied to `status='retracted'` (3/4 retracted lack review msg) and `status='denied'` (3/4 denied lack review msg). Worth confirming with Agent B's writer audit.

**Status cardinality:**
| status     | count |
|------------|-------|
| approved   | 10    |
| denied     | 4     |
| retracted  | 4     |

**Resolution time (resolved_at - created_at):** min 5.7s, max 16,978s (~4.7 hr). Wide spread — note for any time-to-resolve metric.

### `background_jobs`
- **Rows:** 4.
- **Time range (created_at):** 2026-03-24 → 2026-04-10.
- **Distinct guilds:** 1.

| Column            | Null in dev | % populated |
|-------------------|------------|-------------|
| completed_at      | 1 / 4      | 75%         |
| cursor            | 2 / 4      | 50%         |
| final_cursor      | 1 / 4      | 75%         |
| last_error        | 3 / 4      | 25%         |
| notify_channel_id | 0 / 4      | 100%        |

**Cardinality:**
| job_type             | status     | count |
|----------------------|------------|-------|
| bulk_role_assignment | completed  | 3     |
| bulk_role_assignment | failed     | 1     |

- Only **one** `job_type` (`bulk_role_assignment`) exercised in dev. If other job types exist in code (Agent B should confirm), they aren't represented locally.
- `notify_channel_id` is **always populated** in dev despite being nullable — likely the writer always sets it.
- `last_error` is null on the 3 completed rows and set on the 1 failed row — consistent with naming.
- Operational-only table; no GTM use.

### `deletion_log_threads`
- **Rows:** 2.
- **ANOMALY (writer bug, surface to team):** `created_at` for both rows is the literal string `"CURRENT_TIMESTAMP"`, not an actual timestamp.
- Schema declares the column with a default of `CURRENT_TIMESTAMP`, but Kysely / better-sqlite3 appears to be inserting the literal string rather than evaluating the SQL keyword. See feedback note `feedback_kysely_sqlite_defaults.md` for the same pattern. This needs a writer fix; downstream, any time-based analysis on `deletion_log_threads.created_at` is currently unusable.
- **Distinct guilds:** 1.

### `guild_subscriptions`
- **Rows:** 2.
- **Time range (created_at):** 2026-03-19 → 2026-03-20.
- **Distinct guilds:** 2 (both populated, no null `guild_id`).

| Column                 | Null in dev | % populated |
|------------------------|------------|-------------|
| guild_id               | 0 / 2      | 100%        |
| created_at             | 0 / 2      | 100%        |
| updated_at             | 0 / 2      | 100%        |
| current_period_end     | 2 / 2      | 0% (always null) |
| stripe_customer_id     | 2 / 2      | 0% (always null) |
| stripe_subscription_id | 2 / 2      | 0% (always null) |

**Cardinality:**
| product_tier | status | count |
|--------------|--------|-------|
| free         | active | 2     |

- All Stripe fields are null because both subscriptions are `free` tier — consistent with the model: free tier doesn't go through Stripe. Cannot validate the paid-tier code path locally; will need a prod row with `product_tier = 'paid'` to confirm `stripe_*` and `current_period_end` get populated.
- **No `null guild_id` rows in dev** — the brief warned about those in prod; flag if they appear in the backup.

### `guilds`
- **Rows:** 2.
- All rows have non-null `id` (despite schema declaring `id` as nullable).
- `settings` is also fully populated (180 and 212 chars respectively).
- Both columns are **schema-nullable but 100% populated** in dev. Agent A should confirm whether `id` being nullable is a schema accident; if so, treat as effectively non-null.

### `honeypot_config`
- **Rows:** 3, across 2 distinct guilds (one guild has 2 honeypot channels, the other 1).
- No nullable columns.

### `mod_actions`
- **Rows:** 3.
- **Time range (created_at):** 2026-03-20 → 2026-03-23.
- **Distinct guilds:** 2.

| Column            | Null in dev | % populated |
|-------------------|------------|-------------|
| duration          | 2 / 3      | 33%         |
| executor_id       | 0 / 3      | 100%        |
| executor_username | 0 / 3      | 100%        |
| reason            | 0 / 3      | 100%        |

**Cardinality:**
| action_type      | count |
|------------------|-------|
| kick             | 1     |
| timeout          | 1     |
| timeout_removed  | 1     |

- Only 3 rows — far below useful sample. Three distinct `action_type` values exercised; Agent A's migration audit should enumerate the full enum so we know what *else* could appear.
- `duration` null on `kick` and `timeout_removed`, set on `timeout` — sensible (only `timeout` is a duration-bearing action).
- `executor_id` and `executor_username` are **always populated in dev**. Schema makes them nullable, perhaps to support automod-driven actions that don't have a human executor. **Critical to recheck in prod** — if automod writes here at all, `executor_id` should be null for some rows.

### `reported_messages`
- **Rows:** 12.
- **Time range (created_at):** 2026-03-20 → 2026-05-07 (~7 weeks active).
- **Distinct guilds:** 2.

| Column          | Null in dev | % populated |
|-----------------|------------|-------------|
| deleted_at      | 11 / 12    | 8%          |
| extra           | 2 / 12     | 83%         |
| staff_id        | 2 / 12     | 83%         |
| staff_username  | 2 / 12     | 83%         |

**Staff vs anonymous:**
| kind       | count |
|------------|-------|
| staff      | 10    |
| anonymous  | 2     |

**Reason cardinality:**
| reason | count |
|--------|-------|
| spam   | 10    |
| track  | 2     |

- 2/12 are anonymous reports (`staff_id IS NULL`) — per project brief, never join these to `users` in published output.
- `staff_id` and `staff_username` null counts match (2 each) — consistent.
- `deleted_at` populated only 1 / 12 times. Likely the column is set only when staff explicitly deletes via the report flow. Will need Agent B to confirm writer paths before deriving any "reports → deletion conversion" metric.
- Only two `reason` values present (`spam`, `track`); migrations may permit others. Confirm with Agent A.

### `tickets_config`
- **Rows:** 7.
- `channel_id` null in 1 / 7 rows (86% populated). Schema-nullable; in dev *almost* always populated.
- No timestamp column — cannot derive "feature configured at" time. Note this for the "feature activation at day 7/30" metric in Phase 2: `tickets_config` rows give us *whether* tickets is configured, not *when*.

### `user_threads`
- **Rows:** 5.
- **Time range (created_at):** 2026-03-20 → 2026-05-07.
- **Distinct guilds:** 2; distinct users: 3.
- No nullable columns (apart from the generated default on `created_at`, which is set).

### `kysely_migration`
- **Rows:** 29 migrations applied.
- **Time range:** 2026-03-19 → 2026-03-22.
- Operational only; useful as a sanity check that dev and prod schema versions match. Agent A should cross-reference.

### `kysely_migration_lock`
- 1 row (`is_locked = 0`). Plumbing only.

---

## Anomalies and yellow flags

1. **`deletion_log_threads.created_at` is the literal string `"CURRENT_TIMESTAMP"`** in all 2 rows. Writer or migration bug: SQL keyword being inserted as string. The same anti-pattern is noted in user memory (`feedback_kysely_sqlite_defaults.md`). All deletion-log time-series analysis is currently unreliable.
2. **`guilds.id` is nullable in schema but never null in practice.** Likely a schema accident. Should be confirmed with Agent A; if so, treat as effectively non-null in queries.
3. **`guild_subscriptions` Stripe fields all null in dev.** Expected (free tier), but means the paid-tier writer path is untested locally. Prod backup must have at least one `paid` row to validate the funnel logic that depends on these columns.
4. **`mod_actions.executor_id` is 100% populated in dev** despite being nullable. If automod is supposed to write rows here without a human executor, that path is not exercised in dev. Recheck in prod.
5. **`background_jobs` only sees `bulk_role_assignment`.** If other job types are defined in code, they aren't run in dev.
6. **No 1970 timestamps detected** — checked min `created_at` on every populated table; earliest is 2026-03-19. No bogus epoch values in dev.
7. **All "load-bearing for GTM" tables are either empty or nearly empty in dev:**
   - `escalations` / `escalation_records`: **0 rows.**
   - `mod_actions`: 3 rows.
   - `reported_messages`: 12 rows.
   - `message_stats`: 0 rows.
   - The case-study numbers depend almost entirely on data that doesn't exist in dev. Plan all Phase 2 validation work to happen against the prod backup.

---

## Summary for parent agent

- Checked **21 tables** in the local dev DB (19 application tables + 2 Kysely plumbing).
- **8 tables empty**, blocking local sanity checks until the prod backup arrives: `channel_info`, `escalations`, `escalation_records`, `message_cache`, `message_stats`, `reactji_channeler_config`, `sessions`, `users`.
- **All GTM-load-bearing tables are empty or tiny in dev** — the case study and funnel must be validated against prod data.
- **Anomalies flagged:** `deletion_log_threads.created_at` writer bug storing the literal string `"CURRENT_TIMESTAMP"`; `mod_actions.executor_id` always populated despite being nullable (automod path not exercised); `guilds.id` nullable in schema but never null in practice; `guild_subscriptions` paid-tier path untested locally (all rows free-tier with null Stripe fields).
- **No 1970 epoch dates** or other schema-drift symptoms detected in dev.
