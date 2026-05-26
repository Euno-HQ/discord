# Phase 1 Inventory: Schema + Migration History

**Date:** 2026-05-11
**Author:** Phase 1 Agent A (schema scope)
**Companion deliverables (other agents):**

- Agent B will document writer paths (which file/function inserts rows).
- Agent C will spot-check population against the local dev DB.

This document is the canonical reference for "what does the production schema
actually look like, and when did each piece ship?" derived from `app/db.d.ts`
and the `migrations/` directory in chronological order. Tables are presented in
the order they appear in `app/db.d.ts` (which matches the alphabetical-by-table
order Kysely codegen emits).

## At-a-glance bucket assignment

| Table | Bucket | Notes |
| --- | --- | --- |
| `mod_actions` | Load-bearing | Shipped late (2026-02-20). Cohort-gated. |
| `escalations` | Load-bearing | Shipped 2025-11-28; altered twice (voting_strategy, scheduled_for). |
| `escalation_records` | Load-bearing | Co-shipped with `escalations`. |
| `reported_messages` | Load-bearing | Anonymous-report marker (`staff_id IS NULL`) — privacy critical. |
| `guild_subscriptions` | Load-bearing | The funnel anchor. `guild_id` is nullable — known issue. |
| `message_stats` | Load-bearing | Long-running activity table (2024-09); supports "active mod" metrics. |
| `tickets_config` | Load-bearing (activation) | Feature-config table. |
| `honeypot_config` | Load-bearing (activation) | Feature-config table. |
| `reactji_channeler_config` | Load-bearing (activation) | Feature-config table. |
| `application_config` | Load-bearing (activation) | Feature-config table (newest activation surface). |
| `applications` | Load-bearing | Mod-application funnel; per-user state machine. |
| `guilds` | Supporting | Pre-historic; settings blob. |
| `users` | Supporting | Web-auth identity; not Discord users. |
| `user_threads` | Supporting | Per-user mod-log thread mapping. |
| `deletion_log_threads` | Supporting | Per-user deletion-log thread mapping. |
| `message_cache` | Supporting (privacy-hot) | Holds message *content*. Never publish. |
| `channel_info` | Supporting | Channel name/category lookup. |
| `background_jobs` | Operational only | Job queue state. |
| `sessions` | Operational only | Web session store. |

## Cohort-analysis ship-date timeline

These are the dates that gate "what can we measure for which guilds":

| Ship date | Migration | Table / change | Cohort implication |
| --- | --- | --- | --- |
| 2022-04-26 | `20220426042719_init.ts` | `users`, `sessions` | Web-auth scaffolding only. |
| 2022-05-26 | `20220526193702_guilds.ts` | `guilds` | Earliest guild-level record. |
| 2024-09-06 | `20240906155529-message_stats.ts` | `message_stats` | Activity measurable from this date forward. |
| 2025-03-25 | `20250325193821_tickets.ts` | `tickets_config` | Tickets activation measurable. |
| 2025-05-31 | `20250531182208_channel_info.ts` | `channel_info` | Channel lookups. |
| 2025-06-28 | `20250628100531_guild_subscriptions.ts` | `guild_subscriptions` | Funnel can start here, but `created_at` for pre-existing rows was clobbered (see corruption note below). |
| 2025-07-25 | `20250725192908_user_threads.ts` | `user_threads` | — |
| 2025-07-26 | `20250726155346_reported_messages.ts` | `reported_messages` | Anonymous-report metric becomes measurable. |
| 2025-11-28 | `20251128120000_escalation_votes.ts` | `escalations`, `escalation_records` | **Democratic-moderation wedge becomes measurable from here forward — strict cohort gate.** |
| 2025-12-04 | `20251204174954_reactji_channeler.ts` | `reactji_channeler_config` | Reactji activation measurable. |
| 2025-12-06 | `20251206211600_add_honeypot_config.ts` | `honeypot_config` | Honeypot activation measurable. |
| 2026-02-17 | `20260217000000_deletion_log_threads.ts` | `deletion_log_threads` | — |
| 2026-02-18 | `20260218000000_message_cache.ts` | `message_cache` | Spam-detection cache; content present (never publish). |
| 2026-02-20 | `20260220120000_mod_actions.ts` | `mod_actions` | **The headline "auto-deleted / banned / muted" metric is only valid post-2026-02-20.** Pre-existing mod actions are NOT backfilled. |
| 2026-03-13 | `20260313000000_channel_info_category_id.ts` | `channel_info.category_id` added | Category joins more stable from here. |
| 2026-03-19 | `20260319000000_application_config.ts` | `application_config` | — |
| 2026-03-20 | `20260320000000_applications.ts` (+ two follow-ups same day) | `applications` (+ `log_message_id`, `review_message_id`) | Mod-application funnel measurable. |
| 2026-03-22 | `20260322000000_background_jobs.ts` | `background_jobs` | Operational only. |

**Critical caveat: timestamp corruption.** Two corrective migrations
(`20260218120000_fix_created_at_defaults.ts` and
`20260220130000_recover_dates_from_snowflakes.ts`) attempted to recover
`created_at` values that had been stored as the literal string
`'CURRENT_TIMESTAMP'` (a long-running bug from quoted defaults).

- `reported_messages`, `user_threads`, `deletion_log_threads`: timestamps for
  corrupted rows were recovered from Discord snowflake IDs. Reasonably trustworthy.
- `guild_subscriptions`: no snowflake to recover from. Rows that were broken
  before 2026-02-18 had their `created_at` clobbered to `datetime('now')` at
  migration time — meaning **install dates for the oldest cohort are not
  recoverable**. Validation script must flag this.

---

## Per-table detail

### `application_config`

- **Purpose:** Per-guild config for the mod-application feature — points at the
  Discord channel/message/role used to drive applications.
- **Ship date:** 2026-03-19 (`20260319000000_application_config.ts`).
- **GTM relevance:** activation (feature-config).
- **Bucket:** Load-bearing (activation).

| Column | Type | Notes |
| --- | --- | --- |
| `guild_id` | `string` | PK. |
| `channel_id` | `string` | Discord channel where applications are posted. |
| `role_id` | `string` | Role granted on acceptance. |
| `message_id` | `string` | Pinned/instructional message. |

No nullable columns; presence of a row = feature configured.

### `applications`

- **Purpose:** One row per submitted mod application; tracks the per-user state
  machine (pending → resolved).
- **Ship date:** 2026-03-20 (`20260320000000_applications.ts`); altered same day
  with `log_message_id` (`20260320100000_applications_log_message.ts`) and
  `review_message_id` (`20260320200000_applications_review_message.ts`).
- **GTM relevance:** funnel / activation (applications-per-guild, conversion).
- **Bucket:** Load-bearing.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK. |
| `guild_id` | `string` | — |
| `user_id` | `string` | Applicant. Privacy: do not publish. |
| `thread_id` | `string` | Discord thread for the application. |
| `status` | `Generated<string>` | Defaults to `"pending"`. Other states are application-defined. |
| `reviewed_by` | `string \| null` | Null while pending. |
| `created_at` | `string` | Not `Generated<>` — application supplies the value (text column). |
| `resolved_at` | `string \| null` | Null while pending. |
| `log_message_id` | `string \| null` | Added in 2nd migration; null on pre-existing rows. |
| `review_message_id` | `string \| null` | Added in 3rd migration; null on pre-existing rows. |

Indexed by `(guild_id, user_id, status)`.

### `background_jobs`

- **Purpose:** Persistent job queue for long-running operations (backfills,
  cross-guild batch work). Multi-phase progress tracking.
- **Ship date:** 2026-03-22 (`20260322000000_background_jobs.ts`).
- **GTM relevance:** none — purely operational.
- **Bucket:** Operational only.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK. |
| `guild_id` | `string` | — |
| `job_type` | `string` | Application-defined. |
| `status` | `Generated<string>` | Defaults to `"pending"`. |
| `payload` | `string` | Free-text JSON-ish blob. **Never publish.** |
| `cursor` / `final_cursor` | `string \| null` | Resumable pagination. |
| `phase` / `total_phases` | `Generated<number>` | Default 1. |
| `progress_count` / `error_count` | `Generated<number>` | Default 0. |
| `last_error` | `string \| null` | Free-text. Internal only. |
| `notify_channel_id` | `string \| null` | Where to ping on completion. |
| `created_at` / `updated_at` | `string` | Application-supplied (text, not Generated). |
| `completed_at` | `string \| null` | Null until done. |

Indexed by `(status, job_type)`.

### `channel_info`

- **Purpose:** Lookup table caching Discord channel name / category. Used to
  attach human-readable labels to stats without a Discord API call.
- **Ship date:** 2025-05-31 (`20250531182208_channel_info.ts`); altered
  2026-03-13 to add `category_id` (`20260313000000_channel_info_category_id.ts`)
  for stable category joins after rename.
- **GTM relevance:** supporting (joins for case-study breakdowns by channel
  category — but never publish raw channel names from non-Reactiflux guilds).
- **Bucket:** Supporting.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string \| null` | Codegen marks nullable; in practice PK in DDL. |
| `name` | `string \| null` | Channel name; may be stale. |
| `category` | `string \| null` | Category *name*; stale after rename. |
| `category_id` | `string \| null` | Added 2026-03-13; null for pre-existing rows. |

All columns codegen as nullable — typical Kysely behaviour for SQLite tables
with no `notNull()` declarations. Treat with caution.

### `deletion_log_threads`

- **Purpose:** Maps `(user_id, guild_id)` → the per-user thread in the deletion
  log channel where their deletions accumulate.
- **Ship date:** 2026-02-17 (`20260217000000_deletion_log_threads.ts`).
- **GTM relevance:** supporting (no direct metric).
- **Bucket:** Supporting.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | `string` | — |
| `guild_id` | `string` | — |
| `thread_id` | `string` | Snowflake; usable for ts recovery. |
| `created_at` | `Generated<string>` | `CURRENT_TIMESTAMP` default. Recovered from snowflake in the 2026-02-20 fix migration. |

Unique index on `(user_id, guild_id)`.

### `escalation_records`

- **Purpose:** Individual votes cast in an escalation. One row per vote.
- **Ship date:** 2025-11-28 (`20251128120000_escalation_votes.ts`, co-shipped
  with `escalations`).
- **GTM relevance:** case-study (vote counts) and feature-engagement.
- **Bucket:** Load-bearing.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK. |
| `escalation_id` | `string` | FK to `escalations.id` (no formal constraint). |
| `voter_id` | `string` | Privacy: internal joins only. |
| `vote` | `string` | Application-defined (e.g. mute/ban/dismiss). |
| `voted_at` | `Generated<string>` | `CURRENT_TIMESTAMP` default. |

Indexed by `escalation_id`.

### `escalations`

- **Purpose:** A single escalation event — a moderation case put to a vote.
- **Ship date:** 2025-11-28 (`20251128120000_escalation_votes.ts`); altered
  2025-12-09 (`20251209140659_add_voting_strategy.ts` → `voting_strategy`) and
  2025-12-17 (`20251217145416_add_scheduled_for.ts` → `scheduled_for`,
  backfilled from a 36 − 4×voteCount hour formula).
- **GTM relevance:** case-study (democratic-moderation wedge), funnel
  (escalations-per-guild as a wedge-activation signal).
- **Bucket:** Load-bearing.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK. |
| `guild_id` | `string` | — |
| `thread_id` | `string` | Discord thread the escalation happens in. |
| `vote_message_id` | `string` | Discord message hosting the vote UI. |
| `reported_user_id` | `string` | Privacy: internal only. |
| `initiator_id` | `string` | Privacy: internal only. |
| `flags` | `string` | Free-text JSON-ish bitfield. Internal only. |
| `created_at` | `Generated<string>` | `CURRENT_TIMESTAMP` default. |
| `resolved_at` | `string \| null` | Null while pending — primary "resolved" marker. |
| `resolution` | `string \| null` | Application-defined outcome. |
| `voting_strategy` | `string \| null` | Added 2025-12-09; null on pre-existing rows. |
| `scheduled_for` | `string \| null` | Added 2025-12-17; backfilled for then-pending rows. |

Indexed by `(guild_id, resolved_at)`.

### `guild_subscriptions`

- **Purpose:** Per-guild billing state; the install record (in practice, a row
  exists as soon as the bot is in the guild — even on the free tier).
- **Ship date:** 2025-06-28 (`20250628100531_guild_subscriptions.ts`).
- **GTM relevance:** **funnel anchor** — installs, trial→paid conversion,
  retention cohorts.
- **Bucket:** Load-bearing.

| Column | Type | Notes |
| --- | --- | --- |
| `guild_id` | `string \| null` | DDL says PK, codegen says nullable — almost certainly safe in practice but validation should confirm no NULL rows. Kickoff doc explicitly warns about this. |
| `stripe_customer_id` | `string \| null` | Null on free-tier installs. |
| `stripe_subscription_id` | `string \| null` | Null on free-tier installs. |
| `product_tier` | `Generated<string>` | Defaults to `"free"`. |
| `status` | `Generated<string>` | Defaults to `"active"`. |
| `current_period_end` | `string \| null` | Set for paid subscriptions. |
| `created_at` | `Generated<string \| null>` | Originally quoted default ('CURRENT_TIMESTAMP') — was bug, fixed in `20260218120000_fix_created_at_defaults.ts` by clobbering broken rows to `datetime('now')`. **Pre-2026-02-18 install dates are NOT trustworthy.** |
| `updated_at` | `Generated<string \| null>` | Same caveat as `created_at`. |

### `guilds`

- **Purpose:** Pre-historic per-guild settings blob. Mostly superseded by the
  per-feature `*_config` tables.
- **Ship date:** 2022-05-26 (`20220526193702_guilds.ts`).
- **GTM relevance:** supporting (existence-of-row pre-dates `guild_subscriptions`).
- **Bucket:** Supporting.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string \| null` | `serial` in the DDL (Postgres-ism that SQLite ignores); codegen sees no `notNull`. |
| `settings` | `string \| null` | `jsonb` in DDL; free-text JSON. Internal only — possibly contains channel IDs / role IDs. |

Worth flagging: this table is unused by most current code paths (Agent B can
confirm). It may be effectively dead — useful only as a "this guild existed
prior to subscriptions" signal.

### `honeypot_config`

- **Purpose:** Per-guild list of channels designated as honeypot channels for
  spam detection. Composite PK on `(guild_id, channel_id)` — many rows per guild.
- **Ship date:** 2025-12-06 (`20251206211600_add_honeypot_config.ts`).
- **GTM relevance:** activation (a guild with any honeypot row has the feature
  configured).
- **Bucket:** Load-bearing (activation).

| Column | Type | Notes |
| --- | --- | --- |
| `guild_id` | `string` | Composite PK. |
| `channel_id` | `string` | Composite PK. |

### `message_cache`

- **Purpose:** Short-lived cache of recent message content, used by spam
  detection (e.g. forwarded-message bypass, cross-channel dedupe).
- **Ship date:** 2026-02-18 (`20260218000000_message_cache.ts`).
- **GTM relevance:** supporting (no direct metric, supports spam-detection
  logic). **Privacy: holds `content` — never publish, even in aggregate.**
- **Bucket:** Supporting (privacy-hot).

| Column | Type | Notes |
| --- | --- | --- |
| `message_id` | `string` | PK. |
| `guild_id` | `string` | — |
| `channel_id` | `string` | — |
| `user_id` | `string` | Privacy: internal only. |
| `content` | `string \| null` | **Message body text. Never publish.** |
| `last_touched` | `string` | Last time the row was used (for TTL eviction). |
| `created_at` | `string` | Application-supplied; not `Generated<>`. |

### `message_stats`

- **Purpose:** Per-message aggregate stats (char/word/react counts, derived code
  and link breakdowns). Activity-tracker fact table.
- **Ship date:** 2024-09-06 (`20240906155529-message_stats.ts`); altered
  2025-05-31 (`20250531210224-message_code_stats.ts` → `code_stats`) and
  2025-06-12 (`20250612220730_message_links.ts` → `link_stats`).
- **GTM relevance:** case-study (active mod count, channel-category activity);
  funnel (volume signal). **Aggregate-only for publication.**
- **Bucket:** Load-bearing.

| Column | Type | Notes |
| --- | --- | --- |
| `message_id` | `string \| null` | DDL PK; codegen nullable. |
| `author_id` | `string` | Privacy: internal joins only. |
| `guild_id` | `string` | — |
| `channel_id` | `string` | — |
| `channel_category` | `string \| null` | Cached at write time; may diverge from `channel_info`. |
| `recipient_id` | `string \| null` | Populated for DM-like contexts. |
| `char_count` | `number` | — |
| `word_count` | `number` | — |
| `react_count` | `Generated<number>` | Default 0. |
| `sent_at` | `number` | Unix-ish integer timestamp (distinct from `created_at` convention elsewhere). |
| `code_stats` | `Generated<string>` | JSON array string; default `"[]"`. Internal only. |
| `link_stats` | `Generated<string>` | JSON array string; default `"[]"`. Internal only. |

**Quirk:** `sent_at` is an integer (likely ms-since-epoch); not a datetime
string like other tables. Scripts must handle the conversion.

### `mod_actions`

- **Purpose:** Headline log of moderation enforcement — bans, mutes, kicks, etc.
  This is the table behind the GTM headline metrics.
- **Ship date:** 2026-02-20 (`20260220120000_mod_actions.ts`). **No
  backfill** — only enforcement actions on or after 2026-02-20 are present.
- **GTM relevance:** case-study (the primary mod-actions-per-week number);
  funnel (time-to-first-mod-action = time-to-first-value).
- **Bucket:** Load-bearing.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK. |
| `user_id` | `string` | Subject of the action. Privacy: internal only. |
| `guild_id` | `string` | — |
| `action_type` | `string` | Application-defined (ban / mute / kick / warn / automod-delete / etc.). Agent B will document the enum. |
| `executor_id` | `string \| null` | Null implies automated (automod) — important distinction for "mod-hours saved" estimates. |
| `executor_username` | `string \| null` | Internal only. |
| `reason` | `string \| null` | Free-text. Internal only. |
| `duration` | `string \| null` | E.g. mute duration. |
| `created_at` | `string` | Application-supplied; not `Generated<>`. |

Indexed by `(user_id, guild_id)`.

### `reactji_channeler_config`

- **Purpose:** Per-guild config: when N users react with emoji X, mirror the
  message to channel Y. Several rows per guild possible.
- **Ship date:** 2025-12-04 (`20251204174954_reactji_channeler.ts`).
- **GTM relevance:** activation (any row = feature configured).
- **Bucket:** Load-bearing (activation).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK. |
| `guild_id` | `string` | — |
| `channel_id` | `string` | Target channel. |
| `emoji` | `string` | — |
| `configured_by_id` | `string` | Internal only. |
| `threshold` | `Generated<number>` | Default 1. |
| `created_at` | `Generated<string>` | `CURRENT_TIMESTAMP` default. |

Unique constraint on `(guild_id, emoji)`.

### `reported_messages`

- **Purpose:** Anonymous & staff reports against a Discord message. Behind the
  "anonymous reports" wedge.
- **Ship date:** 2025-07-26 (`20250726155346_reported_messages.ts`); altered
  same day (`20250726201405_add_unique_constraint_reported_messages.ts` —
  uniqueness on `(reported_message_id, reason, guild_id)`) and
  2025-07-26 (`20250726215517_add_deleted_at_to_reported_messages.ts` →
  `deleted_at`).
- **GTM relevance:** case-study (anonymous vs staff report counts; report →
  enforcement conversion); funnel.
- **Bucket:** Load-bearing. **Privacy-critical: `staff_id IS NULL` ⇒ anonymous;
  must never be joined back to a user identity in any published output.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK (uuid). |
| `reported_message_id` | `string` | Snowflake of the reported Discord message. Indexed. |
| `reported_channel_id` | `string` | — |
| `reported_user_id` | `string` | Privacy: internal joins only. Indexed with guild. |
| `guild_id` | `string` | — |
| `log_message_id` | `string` | Used as the snowflake source for `created_at` recovery (see corruption note). |
| `log_channel_id` | `string` | — |
| `reason` | `string` | Application-defined. |
| `staff_id` | `string \| null` | **Null = anonymous. Privacy-load-bearing.** |
| `staff_username` | `string \| null` | Same. |
| `extra` | `string \| null` | Free-text. **Never publish** — may contain quoted message content. |
| `created_at` | `Generated<string>` | Default `CURRENT_TIMESTAMP`. Corrupted rows recovered from `log_message_id` snowflake. |
| `deleted_at` | `string \| null` | Added 2025-07-26 follow-up; null = report still active / message not deleted. |

### `sessions`

- **Purpose:** Web-app session store for the React Router dashboard.
- **Ship date:** 2022-04-26 (`20220426042719_init.ts`).
- **GTM relevance:** none.
- **Bucket:** Operational only.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string \| null` | DDL PK. |
| `data` | `string \| null` | Session blob. Internal only. |
| `expires` | `string \| null` | — |

### `tickets_config`

- **Purpose:** Per-guild config for the tickets feature (button-driven private
  threads).
- **Ship date:** 2025-03-25 (`20250325193821_tickets.ts`).
- **GTM relevance:** activation (any row = feature configured).
- **Bucket:** Load-bearing (activation).

| Column | Type | Notes |
| --- | --- | --- |
| `message_id` | `string` | PK. The pinned/UI message hosting the ticket button. |
| `channel_id` | `string \| null` | Where tickets land. Nullable — historical quirk. |
| `role_id` | `string` | Role pinged on new ticket. |

Unusual that there's no explicit `guild_id` column — joins must go through
Discord context. Worth a follow-up question for Agent B.

### `user_threads`

- **Purpose:** Maps `(user_id, guild_id)` → the per-user thread in the mod-log
  channel where their actions accumulate.
- **Ship date:** 2025-07-25 (`20250725192908_user_threads.ts`).
- **GTM relevance:** supporting.
- **Bucket:** Supporting.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | `string` | — |
| `guild_id` | `string` | — |
| `thread_id` | `string` | Snowflake — used for ts recovery. |
| `created_at` | `Generated<string>` | `CURRENT_TIMESTAMP` default. Recovered from snowflake in the 2026-02-20 fix migration. |

Unique index on `(user_id, guild_id)`.

### `users`

- **Purpose:** **Web-auth users** of the dashboard (Discord OAuth identities
  that have logged into the React Router app). NOT a registry of Discord users
  the bot sees.
- **Ship date:** 2022-04-26 (`20220426042719_init.ts`).
- **GTM relevance:** supporting — could power "active dashboard users" but that
  is not on the starter metric list.
- **Bucket:** Supporting.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `string` | PK (uuid). |
| `email` | `string \| null` | Internal only. |
| `externalId` | `string` | Discord user ID. |
| `authProvider` | `Generated<string \| null>` | Defaults to `"discord"`. |

This is one of the easier traps in the schema — joining anything `user_id`-ish
from other tables to `users` will not match by default; other tables store the
Discord snowflake, not the local uuid.

---

## Surprises & follow-ups for downstream agents

1. **Two distinct user-identity columns.** Most application tables store
   Discord snowflakes as `user_id` / `author_id` / etc. The `users` table
   stores its own UUID PK and keeps the Discord ID in `externalId`. Any join
   between application tables and `users` must go through `externalId`. Easy
   bug.
2. **`guild_subscriptions.guild_id` is nullable in codegen.** Validation must
   detect (and likely exclude) any NULL-guild rows in the funnel snapshot. The
   kickoff doc flags this; confirmed in the type.
3. **Timestamp corruption window.** The two corrective migrations in Feb 2026
   mean: (a) `reported_messages` / `user_threads` / `deletion_log_threads`
   timestamps are reasonably trustworthy thanks to snowflake recovery; (b)
   `guild_subscriptions.created_at` for rows that existed before 2026-02-18 is
   not recoverable. Cohort analysis on installs must either start the cohort
   window post-2026-02-18 or accept that the earliest cohort dates are
   wall-clock-from-migration, not true install dates.
4. **`mod_actions` is young (2026-02-20).** Any "lifetime mod actions"
   framing is wrong; metrics must be windowed and date-stamped explicitly.
5. **No backfill on `mod_actions`.** Pre-existing bans/mutes/kicks are not in
   the table. The "active mod count" metric using `mod_actions.executor_id`
   will undercount any mod who has not taken an enforcement action since
   2026-02-20. Cross-check via `escalation_records.voter_id` and
   `reported_messages.staff_id` to broaden the "active mod" definition.
6. **`mod_actions.executor_id IS NULL` is the automation marker.** Critical
   for separating "auto-deleted by bot" from "manually actioned by mod" in the
   case study (and for the "mod-hours saved" model).
7. **`message_cache.content` and `reported_messages.extra` contain free
   message text.** Tag both "never publish" in any extraction script.
8. **`tickets_config` has no `guild_id`.** Suspect that joins to Discord
   context resolve guild_id at runtime. Agent B should clarify whether we can
   actually count "guilds with tickets configured" without an extra lookup.
9. **`channel_info` is fully nullable in codegen.** It's a cache; treat all
   joins to it as left joins and never count it as a fact.
10. **`guilds.settings` (jsonb) may still be load-bearing somewhere.** Codegen
    just sees a free-text JSON column. If it contains channel IDs or feature
    flags that pre-date the `*_config` tables, our activation counts could
    miss early adopters. Agent B's writer-path audit will resolve this.
11. **`message_stats.sent_at` is an integer, not a datetime string.** Likely
    epoch ms. Scripts that compare against `datetime('now')` etc. will
    silently produce wrong answers if this isn't handled.
12. **No formal foreign keys anywhere.** SQLite tolerates this; all
    relationships are by convention. Validation queries should explicitly
    check for orphans (e.g. `escalation_records.escalation_id` with no parent).

## Counts

- Tables documented: **19** (matches the 19 interfaces in `app/db.d.ts`).
- Migrations read: **29** (every file in `migrations/`).
- Tables I could not fully classify: **0** — but two warrant Agent B
  confirmation:
  - `guilds` — whether `settings` is still read/written by any current code.
  - `tickets_config` — how guild_id is resolved without a column.
