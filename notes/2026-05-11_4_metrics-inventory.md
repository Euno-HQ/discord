# Phase 1 Deliverable: Metrics Inventory

**Date:** 2026-05-11
**Branch:** `metrics-research`
**Source documents** (deep dives — read these for column-by-column / writer-by-writer detail):

- `notes/2026-05-11_1_inventory-schema.md` — Agent A — schema + migration history
- `notes/2026-05-11_2_inventory-writers.md` — Agent B — writer call sites + field reliability
- `notes/2026-05-11_3_inventory-local-counts.md` — Agent C — empirical row counts against `mod-bot.sqlite3` dev DB

This document synthesizes the three into one per-table reference. Cross-cutting findings (cohort gates, headline traps, privacy contract) are up front; per-table sections follow.

---

## Read these first — the five traps that change every metric

If you write a query without internalizing these, you will publish a wrong number.

1. **`message_stats` DELETES rows on Discord `MessageDelete`** (`activityTracker.ts:134`). Every "messages deleted" / "spam removed" metric must come from `reported_messages` or `mod_actions` — *never* by counting absent `message_stats` rows. The deleted rows are gone.

2. **`mod_actions` skips bot-driven enforcement** — filter on `executor?.id === guild.client.user?.id` in `modActionLogger.ts`. Auto-kicks from the in-app spam-detection feature are NOT in `mod_actions`. Total enforcement = UNION with `reported_messages WHERE reason='spam'` (and dedupe back-fills with `extra NOT LIKE 'Back-filled%'`). Conversely, Discord-native automod *timeouts* ARE recorded but with `executor_id = NULL` — that's how to tell them apart from human actions.

3. **`reported_messages.staff_id IS NULL` is the anonymity contract.** Anonymous reports must never be joined to anything user-identifying in published output. This is binding per the kickoff doc and `PRIVACY_POLICY.md`.

4. **Two distinct user-identity columns.** `users.id` is a UUID; every application table stores Discord snowflakes. Joining any `*_id` column to `users.id` will silently never match — must go through `users.externalId`.

5. **`guild_subscriptions.created_at` for old rows is unrecoverable.** A migration on 2026-02-18 clobbered rows whose `created_at` had been stored as the literal string `'CURRENT_TIMESTAMP'` (a Kysely/SQLite default bug) to `datetime('now')`. **Install dates before 2026-02-18 are not trustworthy.** `reported_messages` / `user_threads` / `deletion_log_threads` were recovered from Discord snowflake IDs in the same fix migration; `guild_subscriptions` had no snowflake to recover from.

Secondary gotchas, in approximately decreasing severity:

- `reported_messages.reason='spam'` includes back-filled prior duplicates (`spamResponseHandler.ts:278`). One detected spam event yields 5+ rows. Filter `extra NOT LIKE 'Back-filled%'` for unique events.
- `escalations.resolution='track'` is overloaded: zero votes, user-left-before-resolve, AND voted-track all resolve to `track`. Differentiate via `escalation_records`.
- `escalation_records` can have multiple rows per voter per escalation (vote changes are inserts, not updates). Use `COUNT(DISTINCT voter_id)` for unique-voter metrics.
- `guild_subscriptions` records OAuth-completed installs, NOT "completed setup" installs. For "set-up-completed" you need to layer `guilds.settings` (presence of `modLog` + `moderator` keys).
- `tickets_config` has no `guild_id` column — counting "guilds with tickets configured" from SQL alone is impossible. Flag for instrumentation gap.
- `message_stats.sent_at` is an integer (unix ms), not the datetime-string convention elsewhere.
- `deletion_log_threads.created_at` was storing the literal string `"CURRENT_TIMESTAMP"` due to `defaultTo("CURRENT_TIMESTAMP")` in the original migration. **Fixed in this branch** — writer now sets `created_at` explicitly and a recovery migration backfills bad rows from `thread_id` snowflakes. Note that `user_threads`, `reported_messages`, and `guild_subscriptions` migrations have the same broken-default pattern but their writers override it; they're latent landmines if a future writer ever omits `created_at`.
- `reported_messages.reason` enum values `modResolution` and `automod` appear in code but have no live writer path. Treat as dead enum values until proven otherwise against prod data.
- Automod-deleted messages may end up in `reported_messages.reason='automod'`, but Agent B found no writer that emits this; `app/commands/report/automodLog.ts` posts to Discord without calling `recordReport`. **Worth verifying against prod row counts before relying on this enum value.**

---

## Three-bucket classification

| Bucket | Tables |
|---|---|
| **Load-bearing for GTM** | `mod_actions`, `escalations`, `escalation_records`, `reported_messages`, `guild_subscriptions`, `message_stats`, `tickets_config`, `honeypot_config`, `reactji_channeler_config`, `application_config`, `applications` |
| **Supporting** | `guilds`, `users`, `user_threads`, `deletion_log_threads`, `message_cache`, `channel_info` |
| **Operational only** | `background_jobs`, `sessions` |

All 19 application tables in `app/db.d.ts` are classified.

---

## Cohort gates — when each table started recording

This dictates the earliest valid window for any metric. Any "lifetime X" framing is wrong; metrics must be windowed and date-stamped.

| Ship date | Table / change | Cohort implication |
|---|---|---|
| 2022-04-26 | `users`, `sessions` | Web-auth scaffolding only |
| 2022-05-26 | `guilds` | Earliest guild-level record |
| 2024-09-06 | `message_stats` | Activity measurable from here |
| 2025-03-25 | `tickets_config` | Tickets activation measurable |
| 2025-05-31 | `channel_info` | Channel lookup cache (lazy population — older channels missing) |
| 2025-06-28 | `guild_subscriptions` | Funnel can start here, BUT `created_at` clobbered for pre-2026-02-18 rows |
| 2025-07-25 | `user_threads` | — |
| 2025-07-26 | `reported_messages` | Anonymous-report metric measurable |
| **2025-11-28** | **`escalations`, `escalation_records`** | **Democratic-moderation wedge measurable — strict cohort gate** |
| 2025-12-04 | `reactji_channeler_config` | Reactji activation measurable |
| 2025-12-06 | `honeypot_config` | Honeypot activation measurable |
| 2026-02-17 | `deletion_log_threads` | — |
| 2026-02-18 | `message_cache` + the timestamp-corruption fix migration | — |
| **2026-02-20** | **`mod_actions`** | **Headline "auto-deleted / banned / muted" metric only valid from here. No backfill.** |
| 2026-03-19 | `application_config` | — |
| 2026-03-20 | `applications` | Mod-application funnel measurable |
| 2026-03-22 | `background_jobs` | Operational only |

---

## What we can / cannot verify locally before the prod backup arrives

The dev DB at `/Users/vcarl/workspace/mod-bot/mod-bot.sqlite3` has data for only 2 guilds and is missing every load-bearing case-study surface.

**Empty in dev — Phase 2/3 work on these MUST wait for the prod backup:**

- `escalations` (0 rows) — the democratic-moderation wedge
- `escalation_records` (0 rows)
- `message_stats` (0 rows) — activity surface
- `message_cache` (0 rows, also TTL-pruned by design)
- `channel_info` (0 rows)
- `reactji_channeler_config` (0 rows)
- `sessions` (0 rows, expected)
- `users` (0 rows, expected — web-auth only)

**Tiny in dev — query *shape* can be validated locally; numbers are meaningless:**

- `mod_actions` (3 rows, 3 action types, no automod rows)
- `reported_messages` (12 rows, 2 anonymous, no `extra LIKE 'Back-filled%'` patterns)
- `guild_subscriptions` (2 rows, both free-tier; paid-tier query path is **completely untested**)

**Adequate in dev for query validation:**

- `applications` (18 rows, all status values exercised), `tickets_config` (7), `user_threads` (5), `honeypot_config` (3), `background_jobs` (4), `application_config` (2), `guilds` (2)

---

## Per-table reference

Privacy classification key:

- **Aggregate-OK** — counts/timestamps can be published in aggregate form (with the privacy rules in the kickoff doc applied).
- **Internal-only** — never published in any form (operational tables, sensitive joins).
- **Privacy-hot** — contains free text, OAuth tokens, or quoted message content. Never publish; sanitize even in internal sharing.

### `application_config` — load-bearing (activation)

- **Purpose:** Per-guild config for the membership-gate / mod-application feature.
- **Ship date:** 2026-03-19.
- **Writers:** `setupAll.server.ts:278` only — no individual slash command path. One row per guild, upsert on `guild_id` conflict.
- **Schema highlights:** 4 columns (`guild_id` PK, `channel_id`, `role_id`, `message_id`), all non-null, all PII-id.
- **GTM use:** activation snapshot ("% of guilds with member-gate configured"). **Has no timestamp column** — cannot cohort by activation date.
- **Known gaps:** Re-running setup overwrites the row in place (no audit trail). Existence ≠ healthy (the Discord-side message may have been deleted).
- **Local counts:** 2 rows (1 per onboarded dev guild).
- **Privacy:** Aggregate-OK.

### `applications` — load-bearing (funnel)

- **Purpose:** Per-applicant rows in the mod-application state machine (pending → approved | denied | retracted).
- **Ship date:** 2026-03-20 (with same-day follow-ups for `log_message_id` and `review_message_id`).
- **Writers:** `memberApplications.ts` lines 242 (insert pending), 359 (attach log/review message IDs), 464 (approve), 600 (deny), 681 (retract), and 59 (auto-deny on departure from `modActionLogger.ts:186`). **Free-text application answers are NOT stored in the DB — only in Discord channels.**
- **Schema highlights:** `status` (pending/approved/denied/retracted), `reviewed_by` nullable, `resolved_at` nullable.
- **GTM use:** mod-recruitment funnel; time-to-resolve.
- **Known gaps:** Auto-denied-on-departure rows have `reviewed_by = NULL`. To distinguish "mod actively reviewed" from "auto-denied", filter `WHERE reviewed_by IS NOT NULL`. No record of *opening* a modal (only submissions) — abandoned applications leave no trace.
- **Local counts:** 18 rows (10 approved, 4 denied, 4 retracted). Resolution time spread 5.7s → 4.7hr.
- **Privacy:** Aggregate-OK for counts; `user_id` PII-id.

### `background_jobs` — operational only

- **Purpose:** Async job queue. Currently only `bulk_role_assignment` exercised.
- **Ship date:** 2026-03-22.
- **Writers:** `jobRunner.ts` lifecycle functions (insert/claim/checkpoint/error/advance-phase/complete/fail).
- **GTM use:** None. Could derive "% of membership-gate activations that completed successfully" but `applications`/`application_config` is more direct.
- **Known gaps:** Failed jobs stay in `failed` status — no retry. Only one `job_type` defined.
- **Local counts:** 4 rows, 3 completed + 1 failed.
- **Privacy:** Internal-only (`payload` contains role IDs).

### `channel_info` — supporting

- **Purpose:** Lookup cache of Discord channel name + category.
- **Ship date:** 2025-05-31 (`category_id` column added 2026-03-13).
- **Writers:** `app/discord/utils.ts:33` (`getOrFetchChannel`) — first time a channel is referenced by the activity tracker. **Gated on `analytics` feature flag**. No invalidation; channel renames not reflected. No cleanup; deleted channels persist.
- **GTM use:** join target for case-study breakdowns by channel category — but treat as left join (cache is incomplete).
- **Known gaps:** Population is lazy and gated on `analytics`. Guilds without `analytics` will have zero rows. Category names go stale on rename.
- **Local counts:** 0 rows in dev. Cannot validate locally.
- **Privacy:** Aggregate-OK for Reactiflux specifically; channel names from other guilds must never be published.

### `deletion_log_threads` — supporting

- **Purpose:** Per-`(user_id, guild_id)` mapping to the Discord thread holding their deletion-log entries.
- **Ship date:** 2026-02-17.
- **Writers:** `app/models/deletionLogThreads.ts:67` (`upsertDeletionLogThread`).
- **Schema highlights:** `created_at` originally declared with `defaultTo("CURRENT_TIMESTAMP")` (string), which Kysely emitted as `DEFAULT 'CURRENT_TIMESTAMP'` (quoted). Fixed in this branch — see `migrations/20260511000000_fix_deletion_log_threads_created_at.ts` (recovers existing rows from `thread_id` snowflake) and the explicit `created_at: new Date().toISOString()` in `upsertDeletionLogThread`.
- **GTM use:** none direct.
- **Known gaps:** Existence of a row implies user had at least one logged event (including edits, not just deletes) — overstates "users with messages deleted".
- **Local counts:** 2 rows, both with the bug.
- **Privacy:** Internal-only.

### `escalations` — load-bearing (case study — wedge)

- **Purpose:** One row per "should we take action against this user?" vote thread.
- **Ship date:** 2025-11-28; altered 2025-12-09 (`voting_strategy`) and 2025-12-17 (`scheduled_for`).
- **Writers:** `app/commands/escalate/service.ts:108` (`createEscalation`), `:238` (`resolveEscalation`), `:255` (`updateEscalationStrategy`), `:273` (`updateScheduledFor`). Resolution happens via the 15-minute timer in `escalationResolver.ts`, NOT via an explicit button.
- **Schema highlights:** `resolution` is application-defined (`track | timeout | restrict | kick | ban`); `resolved_at IS NULL` is the "still active" marker.
- **GTM use:** **Democratic-moderation wedge metric** — escalations initiated/resolved, time-to-resolution, vote participation rate.
- **Known gaps:** `resolution='track'` is overloaded (voted track | zero votes | user-left-before-resolve all collapse to this). Differentiate by joining `escalation_records`. Tied votes resolve by severity, not consensus — read carefully if reporting "consensus rate".
- **Local counts:** **0 rows.** Cannot validate locally — prod backup required.
- **Privacy:** Aggregate-OK; `reported_user_id`/`initiator_id`/voter IDs PII-id.

### `escalation_records` — load-bearing (case study — wedge)

- **Purpose:** Individual votes cast in an escalation. One row per (escalation, voter, vote-value).
- **Ship date:** 2025-11-28 (co-shipped with `escalations`).
- **Writers:** `app/commands/escalate/service.ts:178` (insert) and `:161` (delete on toggle-off).
- **GTM use:** voter participation rate; consensus detection.
- **Known gaps:** **A user can have multiple rows for one escalation** (vote changes are new inserts, not updates). Use `COUNT(DISTINCT voter_id)` for unique-voter metrics. Toggle-off deletion means historical "I voted X then changed to Y" is not recoverable.
- **Local counts:** **0 rows.** Prod backup required.
- **Privacy:** Aggregate-OK; `voter_id` PII-id.

### `guild_subscriptions` — load-bearing (funnel anchor)

- **Purpose:** Per-guild billing state. In practice: install record (free-tier rows created at OAuth completion).
- **Ship date:** 2025-06-28.
- **Writers:**
  - `subscriptions.server.ts:299` (`initializeFreeSubscription`) — called from `session.server.ts:338` (OAuth callback) AND `setupAll.server.ts:412` (end of setup). Idempotent via `onConflict doUpdateSet`.
  - `subscriptions.server.ts:144` (`updateSubscriptionStatus`).
  - **Stripe webhook → subscription writer path: not located by Agent B** — needs follow-up to confirm exactly which Stripe events set `status` and `current_period_end`. Critical for trial→paid attribution.
- **Schema highlights:** `guild_id` codegen as nullable (DDL says PK; verify no NULL rows). `product_tier` defaults `"free"`. `current_period_end` set on paid only.
- **GTM use:** **funnel anchor** — installs, trial→paid conversion, churn.
- **Known gaps:**
  - **OAuth-completed ≠ setup-completed.** A guild that authorized the bot but abandoned setup has a row. For "real activation funnel" layer `guilds.settings` keys (`modLog` + `moderator`).
  - **Install dates pre-2026-02-18 are clobbered** (corruption fix migration). Earliest reliable cohort starts 2026-02-18.
  - Churn is implicit — `status` flips in-place, no audit trail. Sentry breadcrumbs only.
  - `auditSubscriptionChanges` writes to Sentry, NOT the DB.
- **Local counts:** 2 rows, both free-tier, all Stripe fields NULL. **Paid-tier code path completely untested locally.**
- **Privacy:** Aggregate-OK for counts and tier mix; Stripe IDs internal-only.

### `guilds` — supporting

- **Purpose:** Pre-historic per-guild settings blob. Mostly superseded by `*_config` tables.
- **Ship date:** 2022-05-26.
- **Writers:** `app/models/guilds.server.ts:64` (`registerGuild`, `onConflict doNothing`), `:84` (`setSettings` via `json_patch`), `app/routes/export-data.tsx:207` (delete on data-deletion request).
- **Schema highlights:** `id` codegen as nullable (schema accident; never null in practice); `settings` is a free-text JSON blob.
- **GTM use:** **`guilds.settings` is the only signal for "set-up-completed"** (keys: `modLog`, `moderator`, `restricted`, `quorum`, `deletionLog`, `memberRole`, `applicationChannel`). Use `JSON_EXTRACT(settings, '$.modLog')` etc. for activation queries.
- **Known gaps:**
  - **`GuildCreate` does NOT insert into `guilds`.** Only setup paths do. So a guild that joined but never ran setup has no row here AND has a free-tier row in `guild_subscriptions` — that's the "OAuth-but-abandoned-setup" cohort.
  - No `created_at` column.
  - `settings` is unenforced JSON; relies on writers passing the right shape.
- **Local counts:** 2 rows, both with non-null `id` and ~200-char `settings`.
- **Privacy:** Internal-only (settings may contain channel/role IDs).

### `honeypot_config` — load-bearing (activation)

- **Purpose:** Per-`(guild_id, channel_id)` honeypot channel registration.
- **Ship date:** 2025-12-06.
- **Writers:** `app/commands/setupHoneypot.ts:71` and `setupAll.server.ts:358` — both `onConflict doNothing`.
- **GTM use:** activation count ("% of guilds with any honeypot row").
- **Known gaps:** **No `created_at`** — cannot cohort by activation date. `onConflict doNothing` means re-running setup pointing at a new channel silently does nothing (existing row wins).
- **Local counts:** 3 rows, 2 distinct guilds.
- **Privacy:** Aggregate-OK.

### `message_cache` — supporting (privacy-hot)

- **Purpose:** Rolling 24h cache of message metadata, with content held for 60 minutes.
- **Ship date:** 2026-02-18.
- **Writers:** `app/discord/messageCacheService.ts:58` (upsert on `MessageCreate`), `:82` (touch on edit), `:107` (content TTL: 60min), `:122` (row TTL: 24h delete). Gated on `deletion-log` feature flag.
- **GTM use:** none — intentionally ephemeral.
- **Known gaps:** Not populated for guilds without `deletion-log` flag enabled. **Content is privacy-hot — never publish even in aggregate.**
- **Local counts:** 0 rows in dev.
- **Privacy:** **Privacy-hot.** `content` contains user message text.

### `message_stats` — load-bearing (case study activity surface)

- **Purpose:** Per-message stats (char/word/react counts, code blocks, links). Activity-tracker fact table.
- **Ship date:** 2024-09-06; altered 2025-05-31 (`code_stats`) and 2025-06-12 (`link_stats`).
- **Writers:**
  - `app/discord/activityTracker.ts:46` — insert on `MessageCreate` (gated on `analytics` flag, non-bot users, trackable channel types).
  - `:94` — update on edit (re-computes stats from current content — original content is not preserved).
  - **`:134` — DELETE on `MessageDelete`** ← critical.
  - `:166` / `:197` — increment/decrement `react_count`.
- **Schema highlights:** `sent_at` is an **integer** (unix ms) — distinct from datetime-string convention. `message_id` codegen as nullable.
- **GTM use:** active mod count, channel-category activity breakdowns. **Aggregate only.**
- **Known gaps:**
  - **DELETE on delete** means this table cannot answer "what was deleted?". Use `reported_messages` or `mod_actions` instead.
  - `react_count` can drift on missed events or after row deletion.
  - **`analytics` flag gating** means this is almost certainly only populated for Reactiflux. Funnel-wide metrics from this table are not representative.
- **Local counts:** **0 rows.** Prod backup required.
- **Privacy:** Aggregate-OK for Reactiflux; `author_id`/`recipient_id`/`channel_id` PII-id — never published per-row.

### `mod_actions` — load-bearing (case study headline)

- **Purpose:** Authoritative log of moderation actions (ban / unban / kick / timeout / timeout_removed). Headline GTM table.
- **Ship date:** 2026-02-20. **No backfill** — only actions after this date.
- **Writers:** `app/models/modActions.ts:29` (`recordModAction`) — only writer. Called from `modActionLogger.ts` for `GuildBanAdd` (:65), `GuildBanRemove` (:107), `GuildMemberRemove` after audit-log-confirmed-kick (:194), `GuildMemberUpdate` for timeouts (:328/:338). **Bot self-actions are filtered out.**
- **Schema highlights:** `executor_id` nullable — NULL marks Discord-native automod timeouts. `duration` only set for `action_type='timeout'`, format is a human-readable string (NOT ISO-8601).
- **GTM use:** headline "mod actions per week" for case study; time-to-first-mod-action for funnel ("time to first value").
- **Known gaps:**
  - **Bot-driven enforcement (in-app spam-detection auto-kicks) is NOT recorded here.** Filter on bot executor strips these. For total enforcement, UNION with `reported_messages WHERE reason='spam' AND extra NOT LIKE 'Back-filled%'`.
  - **Discord-native automod IS recorded but with `executor_id = NULL`.** Use this to separate automated from human actions. Critical for "mod-hours saved" model.
  - `created_at` is application-supplied (not Generated). Should be reliable — verify against prod.
  - No backfill before 2026-02-20.
- **Local counts:** 3 rows, 3 different `action_type` values, all with non-null `executor_id` (automod path not exercised in dev).
- **Privacy:** Aggregate-OK; `reason` may contain mod-supplied free text (PII-content) — internal only.

### `reactji_channeler_config` — load-bearing (activation)

- **Purpose:** Per-`(guild_id, emoji)` → forward-to-channel mapping.
- **Ship date:** 2025-12-04.
- **Writers:** `app/commands/setupReactjiChannel.ts:76` — `onConflict (guild_id, emoji) doUpdateSet`. **No delete path exists.**
- **GTM use:** activation count.
- **Known gaps:** No way to disable a mapping via slash command. Has `created_at` (good — can cohort by activation date).
- **Local counts:** 0 rows.
- **Privacy:** Aggregate-OK.

### `reported_messages` — load-bearing (case study + privacy-critical)

- **Purpose:** Audit log of "this message is a problem" events from `/report` (anon), `/track` (mod), spam-detection, escalation resolution.
- **Ship date:** 2025-07-26 (with same-day follow-ups for unique constraint and `deleted_at`).
- **Writers:**
  - `app/models/reportedMessages.ts:53` (`recordReport`) — only insert path.
  - Callers: `userLog.ts:176` (primary, all reasons), `spamResponseHandler.ts:278` (spam back-fill of prior duplicates).
  - `:452` (`markMessageAsDeleted`) — sets `deleted_at` on Discord-message-deleted.
  - `app/routes/export-data.tsx:193` — soft-deletes all rows for a guild on data deletion request.
- **Schema highlights:** `staff_id NULL` = anonymous (privacy contract). `reason` values: `anonReport`, `track`, `spam`, `modResolution` (likely unused), `automod` (likely unused).
- **GTM use:** anonymous vs. staff report counts; report → enforcement conversion; spam volume.
- **Known gaps:**
  - **`reason='modResolution'` and `reason='automod'` enum values have no observed writer path.** Treat as dead until proven otherwise — verify against prod row counts.
  - **Spam rows include back-filled duplicates** — filter `extra NOT LIKE 'Back-filled%'` for unique spam events.
  - **Spam writes set `staff_id` to the BOT user ID, not NULL.** Rows with `reason='spam' AND staff_id IS NOT NULL` look like staff-reported but are auto-detected. Differentiate by `reason`, not `staff_id IS NULL`, when asking "auto vs. manual".
  - `deleted_at` is set only via the report/track UI delete buttons and bulk delete — *not* every Discord-side message deletion. Don't read it as "this Discord message was deleted."
  - Data-deletion soft-deletes ALL of a guild's reports at once — detect and exclude if it skews a time-window analysis.
- **Local counts:** 12 rows (10 spam, 2 track; 2 anonymous, 10 staff). Privacy contract intact in dev. No `automod`/`modResolution` rows.
- **Privacy:** **Privacy-critical.** `staff_id IS NULL` anonymity contract; `extra` is free text (PII-content) and may contain quoted message content.

### `sessions` — operational only

- **Purpose:** Web-app session storage (React Router dashboard).
- **Ship date:** 2022-04-26.
- **Writers:** `app/models/session.server.ts:77/106/114` (create / update / delete).
- **GTM use:** none.
- **Known gaps:** No cleanup of expired rows. `data` contains Discord OAuth tokens — sensitive.
- **Local counts:** 0 rows.
- **Privacy:** **Privacy-hot** (OAuth tokens in `data`).

### `tickets_config` — load-bearing (activation, with caveat)

- **Purpose:** Per-`(channel, message)` → role mapping for ticket buttons.
- **Ship date:** 2025-03-25.
- **Writers:** `app/commands/setupTickets.ts:119/234` (slash + modal-submit fallback), `setupAll.server.ts:403` (web).
- **Schema highlights:** **No `guild_id` column.** No `created_at`.
- **GTM use:** activation — but with the no-`guild_id` caveat below.
- **Known gaps:**
  - **No `guild_id` column.** Cannot answer "which guilds have tickets configured" from SQL alone — would need to walk `channel_id` through the Discord API. **Recommend filing an instrumentation gap.**
  - No `created_at` — can't cohort by activation date.
  - Multiple rows per guild possible (one per ticket button created) — distinct-guild counts overstate adoption.
- **Local counts:** 7 rows, 1 with NULL `channel_id`.
- **Privacy:** Aggregate-OK.

### `user_threads` — supporting

- **Purpose:** Per-`(user_id, guild_id)` mod-private thread mapping.
- **Ship date:** 2025-07-25.
- **Writers:** `app/models/userThreads.ts:68` (`upsertUserThread`). Created on first mod-relevant event per user per guild.
- **GTM use:** none direct; could derive "unique users with at least one mod-relevant event per guild" but Agent B notes this is heterogeneous (a single anon report creates a thread).
- **Known gaps:** `created_at` is *most recent* thread creation, not original (threads can be re-created if old one becomes inaccessible). Recovered from snowflake by the Feb 2026 fix migration — reasonably trustworthy.
- **Local counts:** 5 rows, 3 distinct users, 2 guilds.
- **Privacy:** Internal-only.

### `users` — supporting

- **Purpose:** **Web-app users** (Discord OAuth identities that have logged into the dashboard). NOT a registry of Discord users the bot interacts with.
- **Ship date:** 2022-04-26.
- **Writers:** `app/models/user.server.ts:104` (`createUser`), `:130` (delete-by-email — cleanup/testing only).
- **Schema highlights:** `id` is a UUID; `externalId` is the Discord user ID. **Joins from other tables must go through `externalId`.**
- **GTM use:** could power "active dashboard users" but not on the starter list.
- **Known gaps:** Tiny subset of Discord users — only those who logged into the dashboard. Append-only in practice (deletion path documented but says "contact support").
- **Local counts:** 0 rows.
- **Privacy:** Internal-only (`email` is PII-content).

---

## Phase 2 follow-ups (for the metrics-spec doc)

Things Phase 1 surfaced that Phase 2 must resolve before scripts are written:

1. **Trace the Stripe webhook → `guild_subscriptions` writer path.** Need to know which Stripe events fire and what they set `status` / `current_period_end` to. Likely lives in `app/routes/stripe.*` or similar. Critical for trial→paid attribution metric.
2. **Verify `reported_messages.reason` enum coverage in prod.** If `automod` and `modResolution` truly have zero rows, drop them from any query union; if they exist, find their writer.
3. **Decide how to count "guilds with tickets configured".** The DB cannot answer this without joining via Discord API. Either (a) file an instrumentation gap and add `guild_id` to `tickets_config`, (b) measure indirectly via `guilds.settings`, or (c) accept the limitation and report adoption from web-setup logs.
4. **Decide whether to fix the `deletion_log_threads.created_at` writer bug** before running any time-bound query that touches it. Probably yes — but it's out of scope for metrics work per the kickoff.
5. **Validate the `guild_subscriptions` cohort window.** Confirm with prod data whether installs before 2026-02-18 should be (a) excluded entirely, (b) bucketed as "pre-fix unknown date", or (c) approximated from another signal (Sentry breadcrumbs? Stripe customer creation date?).
6. **Define the "active mod" set.** `mod_actions.executor_id` is the narrowest definition (only mods who have enforced since 2026-02-20). For a fuller picture, UNION distinct `escalation_records.voter_id` and `reported_messages.staff_id` (excluding the bot user ID). Phase 2 must specify which definition each metric uses.
7. **Define the "mod-hours saved" model.** Needs an assumption (e.g., N minutes saved per spam message that would otherwise have been handled manually) — flag for user input before writing the script.
8. **Confirm `guilds.id` is effectively non-null in prod** (it's schema-nullable but never null in dev — likely safe).
9. **Confirm `guild_subscriptions.guild_id` has no NULL rows in prod** (kickoff doc warned; dev has none).
10. **Pull a `kysely_migration` cross-check** from prod to confirm schema parity with dev (29 migrations applied in dev).

---

## Out-of-scope follow-ups (file as separate work, not blocking Phase 2)

- **Tickets feature: add `guild_id` column.** Current schema makes cross-guild analytics impossible.
- **Add `created_at` to `application_config`, `honeypot_config`, `tickets_config`.** All three are activation surfaces; not having activation dates costs us cohort analyses.
- **Consider preserving `escalation_records` history on vote change.** Currently a vote change is a new insert (with no delete), but toggle-off is a delete — so "I voted X then changed to Y" is reconstructible but "I voted X then removed my vote" is not.

---

## Validation summary

| Item | Status |
|---|---|
| All 19 tables in `app/db.d.ts` documented | ✅ |
| All 29 migrations read | ✅ (per Agent A) |
| Writer path identified for every table | ✅ (Agent B confirmed all 19; Stripe webhook path flagged for follow-up) |
| Local row counts captured for every table | ✅ (per Agent C) |
| Three-bucket classification complete | ✅ (11 load-bearing / 6 supporting / 2 operational) |
| Privacy classification per table | ✅ |
| GTM relevance per table | ✅ |
| Cohort ship-date timeline | ✅ |
| Top traps surfaced for downstream queries | ✅ (5 headline + 8 secondary) |
