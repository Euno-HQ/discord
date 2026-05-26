# Phase 1 Agent B: Writer Surface Inventory

**Date**: 2026-05-11
**Scope**: For each DB table, what code writes to it, under what conditions, what fields are reliable.
**Companion docs**: `2026-05-11_1_inventory-schema.md` (Agent A — schema), plus a forthcoming row-count doc (Agent C).

This file is grouped by table. For every table, "Writers" cites `file:function` with line numbers (against the worktree at `/Users/vcarl/workspace/mod-bot/.worktrees/metrics-research/`). Reliability flags are:

- **Always populated** — writer always supplies a non-null value.
- **Sometimes populated** — depends on branch / upstream data. Specific branch named.
- **Default-only** — `Generated<>` column whose value is set by the SQLite default; writer never specifies it.
- **Never populated in practice** — column exists but no writer touches it.

Privacy flags (PII): `[PII-id]` = user/guild/channel/message ID, `[PII-content]` = free text or username. Anything marked as such must be stripped before publication.

---

## `applications`

Tracks join-application submissions in a member-gate flow.

### Writers

- `app/commands/memberApplications.ts:242` (anonymous `Effect.gen` in `modal-apply-to-join` modal-submit handler) — inserts a new row with `status: "pending"` when a user submits the apply modal.
- `app/commands/memberApplications.ts:359` — updates the same row to attach `log_message_id` and `review_message_id` after the review post + mod-log summary are sent.
- `app/commands/memberApplications.ts:59` — `resolveApplicationsForDeparture` updates `status="denied"`, `resolved_at=now` when an applicant leaves before review (called from `GuildMemberRemove` handler in `app/commands/report/modActionLogger.ts:186`).
- `app/commands/memberApplications.ts:464` — `app-approve` handler sets `status="approved"`, `reviewed_by=<approverId>`, `resolved_at=now`.
- `app/commands/memberApplications.ts:600` — `app-deny` handler sets `status="denied"`, `reviewed_by=<denierId>`, `resolved_at=now` (and kicks the applicant).
- `app/commands/memberApplications.ts:681` — `app-retract` handler sets `status="retracted"`, `reviewed_by=<applicantUserId>` (self), `resolved_at=now`.

### Trigger conditions

A row is written only when:
1. The guild has been configured with the application flow (`application_config` row exists, populated by `setupAll.server.ts` web-driven setup).
2. A user clicks the "Apply to Join" button → submits the modal.

If the guild has not enabled the membership gate, **no rows are ever written** for that guild. This means application counts are not comparable across guilds without first checking which guilds have `application_config`.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id` | Always populated | `crypto.randomUUID()` at insert. |
| `guild_id` [PII-id] | Always populated | From interaction. |
| `user_id` [PII-id] | Always populated | Applicant ID. |
| `thread_id` [PII-id] | Always populated | Private application thread created moments before insert. |
| `status` | Always populated | `"pending"` on insert; one of `"pending"`, `"approved"`, `"denied"`, `"retracted"` after resolution. (DB has a `Generated<string>` default, but the writer always passes `"pending"` explicitly.) |
| `created_at` | Always populated | ISO timestamp at insert. |
| `log_message_id` [PII-id] | Sometimes populated | Set in a second `updateTable` call (`memberApplications.ts:359`). **Will be `null` if the mod-log POST failed** — the update is fire-and-forget after a `tryPromise`. Also `null` for early-resolved rows (e.g. applicant left before submission, can't happen given trigger order). |
| `review_message_id` [PII-id] | Sometimes populated | Same second update at 359. `null` if the mod-thread review POST failed. |
| `reviewed_by` [PII-id] | Sometimes populated | `null` while `status="pending"`. Set to approver/denier on resolution. For `"retracted"`, equals `user_id` (self). For `"denied"` via `resolveApplicationsForDeparture` (auto-deny on departure), **never set** — left as `null`. |
| `resolved_at` | Sometimes populated | `null` while pending. ISO timestamp on any resolution path. |

### Known gaps

- **Auto-denied-on-departure rows have `reviewed_by = null`.** `resolveApplicationsForDeparture` only sets `status` and `resolved_at`. If you want "approvals vs. denials by mod", you must filter `WHERE reviewed_by IS NOT NULL` to exclude auto-denials.
- **Free-text content (the "about", "referral", "goals" answers) is NOT stored in this table.** It only goes to Discord channels (mod review thread + applicant private thread). The DB has no record of application text. Good for privacy; means we can't ever publish "average application length" or similar without re-scraping Discord.
- **No record of when the application was opened (only when submitted).** The modal can be abandoned with no DB trace.

---

## `application_config`

Per-guild config for the membership-gate flow.

### Writers

- `app/helpers/setupAll.server.ts:278` — `runSetupAll` upserts on `guild_id` conflict. Only path that writes this table.

### Trigger conditions

A row is written when an admin runs `/setup-all` (web-driven setup) with the membership gate enabled. **No CLI/command-driven equivalent** — `setupReactjiChannel.ts` and `setupHoneypot.ts` and `setupTickets.ts` exist as individual slash commands, but membership-gate config has no individual command. It's setup-all-only.

### Field reliability

All four columns (`channel_id`, `guild_id`, `message_id`, `role_id`) [all PII-id] are **always populated** — no nullable columns, no branches. One row per guild (PK on `guild_id`).

### Known gaps

- No `created_at` / `updated_at` columns. Can't tell when a guild enabled the gate, or whether it's been re-configured.
- If `setupAll` is re-run, the `onConflict` overwrites the entire row in place — prior config is not retained.

---

## `background_jobs`

Async/long-running task queue (currently only `bulk_role_assignment`).

### Writers

- `app/jobs/jobRunner.ts:222` (`createJobEffect`) — inserts a new pending job. Called from:
  - `app/helpers/setupAll.server.ts:299` — `createJob({ jobType: "bulk_role_assignment" })` when membership gate is enabled during web setup.
  - `app/jobs/bulkRoleAssignment.ts` — `activateMembershipGateEffect` (re-)creates the bulk role-assignment job; called from mod-applied "Activate membership gate" button.
- `app/jobs/jobRunner.ts:55` — `claimNextJobEffect` flips `pending` → `processing`.
- `app/jobs/jobRunner.ts:77` — `checkpointJobEffect` updates `cursor`, `progress_count`, `updated_at` during execution.
- `app/jobs/jobRunner.ts:98` — `recordJobErrorEffect` increments `error_count`, sets `last_error`.
- `app/jobs/jobRunner.ts:115` — `advancePhaseEffect` bumps `phase`, clears `cursor`.
- `app/jobs/jobRunner.ts:134` — `completeJobEffect` sets `status="completed"`, `completed_at=now`.
- `app/jobs/jobRunner.ts:150` — `failJobEffect` sets `status="failed"`, `last_error`.
- `app/jobs/bulkRoleAssignment.ts:305` — phase-specific update (review if scoring this in detail).

### Trigger conditions

Rows are written only when the membership-gate setup is enabled in a guild. **There is currently only one job type** (`bulk_role_assignment`); other code paths that look like they could enqueue jobs (e.g. data deletion in `routes/export-data.tsx`) do not.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id`, `guild_id`, `job_type`, `payload` [PII-id, payload contains role IDs] | Always populated at insert. |
| `created_at`, `updated_at` | Always populated at insert. |
| `status` | Always populated | `"pending"` → `"processing"` → `"completed"` or `"failed"`. Has a `Generated<>` default that the writer overrides. |
| `phase`, `total_phases`, `progress_count`, `error_count` | Always populated (numeric, Generated defaults are 0 / 1, writer passes explicit values). |
| `cursor` | Sometimes populated | `null` at insert; set during checkpointing; cleared on phase advance. |
| `final_cursor` | Sometimes populated | Only set if caller passes it. `setupAll` does not. |
| `completed_at` | Sometimes populated | Only set by `completeJobEffect`. `null` for `pending`, `processing`, `failed`. |
| `last_error` | Sometimes populated | Set on transient error or fail. |
| `notify_channel_id` [PII-id] | Sometimes populated | `setupAll` always passes the modLog channel; ad-hoc creators may not. |

### Known gaps

- **Operational-only** — has no GTM/case-study value beyond "did this guild attempt to enable the membership gate?" (which is also implied by `application_config`).
- A failed job stays in `failed` status — no retry/re-queue. To measure successful gate activations, count `WHERE status="completed" AND job_type="bulk_role_assignment"`.

---

## `channel_info`

Cache of Discord channel name + category, populated lazily.

### Writers

- `app/discord/utils.ts:33` (`getOrFetchChannel`) — inserts a row the first time a channel is referenced by the activity tracker. **No `onConflict`** (will throw on duplicate) — the function checks for existence first, but if two messages arrive concurrently for an unknown channel the second insert can fail. The error is not propagated past the activity tracker's `catchAll` log.

### Trigger conditions

A row is inserted only when `getOrFetchChannel` is called for a channel not yet in the table — which only happens in `app/discord/activityTracker.ts:43` for the `message_stats` insert path, gated on the `analytics` feature flag.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id` [PII-id] | Always populated for new inserts | But the column is nullable in the schema (`string \| null`) — possibly seeded data exists with `null` from migration history. |
| `name` [PII-content, channel name is public] | Always populated for new inserts. |
| `category` | Sometimes populated | `null` if the channel has no parent (top-level channel) — `data.parent?.name ?? null`. |
| `category_id` [PII-id] | Sometimes populated | `null` if the channel has no parent. |

### Known gaps

- **No invalidation.** Channel renames are not reflected. Category moves are not reflected. A `channel_info.name` reading "general" today may have been renamed; treat the name as stale.
- **No cleanup.** Deleted channels persist forever.
- Population is **gated on the `analytics` feature flag** (via `activityTracker`'s `runGatedFeature`). Guilds without analytics enabled will have no `channel_info` rows even though their messages get logged elsewhere.

---

## `deletion_log_threads`

Per-user-per-guild thread ID where deletion-log embeds get posted.

### Writers

- `app/models/deletionLogThreads.ts:67` (`upsertDeletionLogThread`) — inserts/updates the row. Called by `doGetOrCreateDeletionLogThread` (same file:167) after creating a new thread.

### Trigger conditions

A row is created the first time a user has a message deleted in a guild that has both:
1. The `deletion-log` feature flag enabled (per `runGatedFeature` call in `deletionLogger.ts`).
2. The `deletionLog` setting set (a configured deletion log channel).

If the bot was offline when the message was sent (i.e. it isn't in `message_cache`), the deletion may be classified as "uncached" and skipped — see `deletionLogger.ts:146` — so no thread is created.

### Field reliability

All four columns are **always populated** when a row exists. `created_at` is `Generated<string>` and uses SQLite's default.

### Known gaps

- **Existence of a row implies the user had at least one deletable event logged in that guild** — but this includes message *edits*, not just deletes (`deletionLogger.ts:323` calls `getOrCreateDeletionLogThread` on edit too). So "count of distinct users with deletion threads" overstates "users who had a message deleted".
- A user who self-deletes a message and was never in `message_cache` (e.g. message sent before bot was online) will have no row.

---

## `escalations`

The core mod-democracy artifact: each row is one "should we take action against this user?" vote thread.

### Writers

- `app/commands/escalate/service.ts:108` (`EscalationServiceLive.createEscalation`) — inserts a new escalation. Called from `app/commands/escalate/escalate.ts:124` (`createEscalationEffect`), which is triggered by an escalate button click on a user-mod thread.
- `app/commands/escalate/service.ts:238` (`resolveEscalation`) — sets `resolved_at`, `resolution` when escalation is resolved. Called from:
  - `app/commands/escalate/escalationResolver.ts:156` and `:188` — the 15-minute auto-resolver tick (`startEscalationResolver` in `app/discord/escalationResolver.ts`).
  - There is **no** explicit "resolve via button" path — resolution happens via timer when `scheduled_for <= now()`.
- `app/commands/escalate/service.ts:255` (`updateEscalationStrategy`) — sets `voting_strategy` (e.g. on upgrade-to-majority).
- `app/commands/escalate/service.ts:273` (`updateScheduledFor`) — updates `scheduled_for` after each vote (`app/commands/escalate/vote.ts:100`) and on strategy upgrades (`escalate.ts:238`).

### Trigger conditions

- Created only when a mod clicks the "Escalate" button on a user-mod thread (which itself requires the `escalate` feature flag to be enabled for the guild — see `escalate.ts:53`).
- Requires guild to have `moderator` setting configured (the role to ping).
- Quorum is set from `DEFAULT_QUORUM = 3` (`models/guilds.server.ts:20`) unless overridden in guild settings.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id`, `guild_id`, `thread_id`, `vote_message_id`, `reported_user_id`, `initiator_id` [PII-id] | Always populated | All provided at insert. |
| `flags` | Always populated | JSON string; currently only `{"quorum": 3}`. |
| `voting_strategy` | Always populated | `"simple"` on insert; flips to `"majority"` on strategy upgrade. Schema marks nullable but writer never inserts null. |
| `created_at` | Always populated | ISO string at insert. (Generated default exists but is overridden.) |
| `scheduled_for` | Always populated | ISO string at insert (computed from `calculateScheduledFor(createdAt, 0)`). Updated on each vote (so it reflects the latest projected auto-resolve time). |
| `resolution` | Sometimes populated | `null` until resolved. One of `"track"`, `"timeout"`, `"restrict"`, `"kick"`, `"ban"` afterward. |
| `resolved_at` | Sometimes populated | `null` until resolved; ISO string after. |

### Known gaps

- **`resolution = "track"` doesn't mean "resolved as track" — it can also mean "resolution executed against a user who left the server" or "zero votes received → defaulted to track".** See `escalationResolver.ts:77` (zero votes → track) and `:163` (user gone → track). Don't read it as "the vote went track" without joining to `escalation_records`.
- **Tied votes are resolved by severity, not consensus.** `escalationResolver.ts:78–88` — if a tie occurs, the most severe option wins. This matters if you want to report "% of escalations that produced a consensus": you'd need to compute it from `escalation_records` rather than `escalations.resolution`.
- **Vote message IDs are populated *after* the message is sent.** There's a brief window where the in-memory `tempEscalation` has `vote_message_id: ""` (`escalate.ts:88`). The DB insert at `service.ts:108` always has the real ID, but if the message-send succeeded and the DB-insert failed, we'd have an orphaned Discord message and no row. (No evidence this has occurred in practice.)

---

## `escalation_records`

Individual votes cast on an escalation. One row per (escalation, voter, vote-value).

### Writers

- `app/commands/escalate/service.ts:178` (`recordVote`) — inserts a vote.
- `app/commands/escalate/service.ts:161` — **deletes** the matching row if the voter clicks the same vote button twice (toggle-off behavior).

### Trigger conditions

A mod clicks a vote button on the escalation message. Toggle behavior: clicking the same vote a second time deletes the row; clicking a different vote inserts a new row without removing the old (so a voter can have multiple rows with different `vote` values — the tally logic in `voting.ts` handles this).

### Field reliability

All five columns are **always populated**:

| Column | Reliability | Notes |
|---|---|---|
| `id` | Always populated | `crypto.randomUUID()` at insert. |
| `escalation_id`, `voter_id` [PII-id] | Always populated. |
| `vote` | Always populated | One of `"track"`, `"timeout"`, `"restrict"`, `"kick"`, `"ban"`. |
| `voted_at` | Always populated | `Generated<>` — uses SQLite default at insert time. |

### Known gaps

- **A user can have multiple rows for one escalation** (e.g. they voted "kick" then changed their mind and voted "ban" without un-voting "kick"). The tally logic dedupes by voter for some queries and counts all rows for others (`voting.ts` `tallyVotes`). For metrics like "distinct voters per escalation", **use `COUNT(DISTINCT voter_id)`**, not `COUNT(*)`.

---

## `guilds`

One row per guild the bot is in. Settings stored as a JSON blob in `settings`.

### Writers

- `app/models/guilds.server.ts:64` (`registerGuild`) — inserts a new guild with `settings: "{}"`, `onConflict doNothing`. Called from setup paths to ensure a row exists. (Note: `onboardGuild.ts` on `GuildCreate` does **not** call `registerGuild` — it only fires metrics. The first call to `setSettings` will silently fail if the row doesn't exist; but actual setup commands all call `registerGuild` first or set settings via `setupAll.server.ts` which uses upserts on dependent tables.)
- `app/models/guilds.server.ts:84` (`setSettings`) — `UPDATE guilds SET settings = json_patch(settings, ...)`. Used by `setupAll.server.ts:322` and every individual `/setup-*` slash command via various code paths.
- `app/routes/export-data.tsx:207` — deletes the guild row on user-requested data deletion.

### Trigger conditions

A row is created when a guild owner/admin actually runs setup (or when a model write calls `registerGuild`). **`GuildCreate` does NOT create a `guilds` row** — only `onboardGuild.ts` runs, which deploys commands and sends a welcome message but doesn't insert. This is important: guild-count metrics based on `guilds` undercount actual installs.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id` [PII-id] | Always populated for any actually-used guild. Schema marks nullable, presumably for migration history. |
| `settings` | Always populated | JSON string. Starts as `"{}"`, grows via `json_patch`. Keys are documented in `SETTINGS` in `guilds.server.ts:10`: `modLog`, `moderator`, `restricted`, `quorum`, `deletionLog`, `memberRole`, `applicationChannel`. |

### Known gaps

- **`guilds` table is not the right place to count "installed guilds".** Use `guild_subscriptions` instead — `SubscriptionService.initializeFreeSubscription` is called in `session.server.ts:338` (on bot-installation OAuth completion) and `setupAll.server.ts:412`. A guild that joined but never ran setup will appear in neither. See "Known gaps" under `guild_subscriptions`.
- **No `created_at` / `updated_at` columns.** Can't tell when a guild was registered or when settings last changed.
- **`settings` is a JSON blob with no schema enforcement.** A bad write could corrupt; the codebase relies on `setSettings` callers passing the right shape.

---

## `guild_subscriptions`

Tracks free-trial / paid subscription state per guild.

### Writers

- `app/models/subscriptions.server.ts:72` (`createOrUpdateSubscription`) — upserts on `guild_id`. Called from:
  - `app/models/subscriptions.server.ts:299` (`initializeFreeSubscription`) — called on bot-install OAuth callback (`session.server.ts:338`) and at end of `setupAll.server.ts:412`.
  - Stripe webhook handlers (must exist, follow up — kickoff references `app/models/subscriptions.server.ts` as load-bearing for paid-tier logic).
- `app/models/subscriptions.server.ts:144` (`updateSubscriptionStatus`) — updates `status` and `current_period_end`.
- `app/routes/export-data.tsx:203` — deletes subscription row on data deletion request.

### Trigger conditions

A row is created when:
1. A user completes the bot-install OAuth flow (`session.server.ts:336` — `if (flow !== "user" && guildId)` → `initializeFreeSubscription`).
2. `setupAll` runs (web-driven setup, end of flow).
3. A Stripe webhook fires (likely `customer.subscription.created`/`.updated` etc.).

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `guild_id` [PII-id] | Sometimes populated | Schema marks nullable, and writer paths always provide a value, but legacy / partially-failed rows may exist. **Worth double-checking with Agent C's row counts whether any `null` guild_id rows exist.** |
| `product_tier` | Always populated | `"free"` on init, `"paid"` after Stripe checkout, `"custom"` for grandfathered/internal. Has Generated default. |
| `status` | Always populated | `"active"` by default. Generated default. |
| `created_at`, `updated_at` | Sometimes populated | `Generated<string \| null>` — writer always provides values now, but historic rows may have `null`. |
| `current_period_end` | Sometimes populated | `null` for free tier; set after a paid checkout completes. |
| `stripe_customer_id`, `stripe_subscription_id` [PII-id] | Sometimes populated | `null` until the guild upgrades to paid. |

### Known gaps

- **The "install" event is double-recorded.** Both the OAuth completion (`session.server.ts:338`) AND `setupAll.server.ts:412` call `initializeFreeSubscription`. They use `onConflict doUpdateSet`, so this is idempotent for `guild_id` — but it also means a guild that completed OAuth but never finished setup still has a `guild_subscriptions` row. So this table **counts ATTEMPTED installs (OAuth completed)**, not "guilds that finished setup". For "setup completed" you'd need to check `guilds.settings` for at least `modLog` and `moderator` keys.
- **`current_period_end` is the only marker of trial expiry.** Free-tier rows have it `null`, paid-tier rows set it on subscription create with `trial_period_days: 90` (`stripe.server.ts:56`). So for trial-end metrics, filter `WHERE product_tier="paid" AND current_period_end IS NOT NULL`.
- **Churn signal is implicit.** A subscription transitioning from `active` → `inactive` (or similar) is recorded only by updating the existing row — there's no audit trail. To compute churn over time you'd need to consult Stripe directly or stand up additional logging.
- The `auditSubscriptionChanges` method (`subscriptions.server.ts:411`) logs to Sentry/breadcrumbs but **never writes to DB**.

---

## `honeypot_config`

One row per guild that has set up a spam honeypot channel.

### Writers

- `app/commands/setupHoneypot.ts:71` — slash-command setup; `onConflict doNothing`, so re-running `/honeypot-setup` is a no-op once a row exists.
- `app/helpers/setupAll.server.ts:358` — web-driven setup; `onConflict doNothing`.

### Trigger conditions

Admin runs `/honeypot-setup` or selects honeypot during web `/setup-all`.

### Field reliability

Both `guild_id` and `channel_id` are **always populated** [PII-id]. No nullable columns, no other fields.

### Known gaps

- **No `created_at` / no audit fields.** Can't tell when a guild enabled honeypot — important for cohort-by-feature analysis. (If you want "% of guilds with honeypot at day 7", you can only compute it as a current snapshot, not historically.)
- `onConflict doNothing` means **re-running honeypot setup never updates the channel.** If an admin runs it pointing at a new channel, the DB still shows the old one. The user-facing message says "Honeypot setup completed successfully!" even when nothing changed.

---

## `message_cache`

24-hour rolling cache of message metadata (and content for the first 60 minutes) so deletions can be logged with author info.

### Writers

- `app/discord/messageCacheService.ts:58` (`MessageCacheServiceLive.upsertMessage`) — inserts/updates on every `MessageCreate` event (called from `deletionLogger.ts:88`). `onConflict` on `message_id` updates `content` and `last_touched`.
- `app/discord/messageCacheService.ts:82` (`touchMessage`) — updates `last_touched` and `content` after a message edit (called from `deletionLogger.ts:321`).
- `app/discord/messageCacheService.ts:107` (`expireContent`) — periodic cleanup: nulls `content` for rows where `last_touched < now-60min`. Runs every 10 minutes.
- `app/discord/messageCacheService.ts:122` (`expireRows`) — periodic cleanup: deletes rows where `created_at < now-24h`. Runs every 10 minutes.

### Trigger conditions

Insert: any message in a guild where the **`deletion-log` feature flag is enabled** (via `runGatedFeature("deletion-log", guildId, ...)` in `deletionLogger.ts:84`). Bot/system messages are excluded.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `message_id`, `guild_id`, `channel_id`, `user_id` [PII-id] | Always populated. |
| `created_at`, `last_touched` | Always populated at insert. |
| `content` [PII-content] | Sometimes populated | Set on insert/touch; **expired to `null` after 60 minutes idle**. So an arbitrary row may have content or not depending on when you query. |

### Known gaps

- **This table is intentionally ephemeral** — `expireRows` deletes rows after 24h. Useless for any historical metric. Operational only.
- **Content is privacy-sensitive** [PII-content]. Never publish even in aggregate.
- Not populated for guilds without the `deletion-log` feature flag. Don't assume row counts approximate message volume.

---

## `message_stats`

Per-message structured stats for activity analytics. **This is the big one** — one row per qualifying message.

### Writers

- `app/discord/activityTracker.ts:46` — insert on `MessageCreate` (gated on `analytics` feature flag).
- `app/discord/activityTracker.ts:94` — update on `MessageUpdate` (re-computes `char_count`, `word_count`, `code_stats`, `link_stats`).
- `app/discord/activityTracker.ts:134` — **delete** on `MessageDelete` (so deleted messages don't pollute analytics).
- `app/discord/activityTracker.ts:166` / `:197` — increment/decrement `react_count` on reaction add/remove.

### Trigger conditions

A row is inserted for any message that:
1. Has the `analytics` feature flag enabled for its guild (per `runGatedFeature` call in `activityTracker.ts:39`).
2. Is from a non-bot, non-system, non-webhook user.
3. Is in one of `TRACKABLE_CHANNEL_TYPES` (text, announcement, voice, forum, public/private/announcement threads).

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `author_id`, `guild_id`, `channel_id` [PII-id] | Always populated. |
| `sent_at` | Always populated | Numeric (unix ms, from `getMessageStats`). |
| `char_count`, `word_count` | Always populated | Computed from message content. |
| `code_stats`, `link_stats` | Always populated | JSON strings; `Generated<>` default of `'[]'` — writer always overrides. |
| `message_id` [PII-id] | Sometimes populated | Schema marks nullable. **Writer always provides it at insert (`activityTracker.ts:51`)**, but the column is nullable for legacy / pre-migration reasons. Possibly historic null rows exist; verify with Agent C. |
| `recipient_id` [PII-id] | Sometimes populated | `msg.mentions.repliedUser?.id ?? null` — only set when the message is a reply. |
| `channel_category` | Sometimes populated | `getOrFetchChannel(msg).category` — `null` for top-level channels. |
| `react_count` | Default-only initially | `Generated<number>` default 0; updated via `+ 1` / `- 1` on reaction events. |

### Known gaps

- **DELETE-on-delete is the headline trap.** Deleted messages are removed from `message_stats` entirely — `activityTracker.ts:134`. This means: count of `message_stats` rows at time T ≠ count of messages sent up to time T. For metrics like "spam messages auto-deleted per week", you **cannot derive this from `message_stats`**, because exactly those are the rows that no longer exist. Use `reported_messages` filtered to `reason IN ('spam', 'automod')` or the audit-log-driven `mod_actions` instead.
- **`react_count` can drift negative or go stale.** If the bot misses a reaction event (rare but possible), the count drifts. If a message is deleted, the row goes; if Discord later replays a reaction event, the update silently no-ops (no row to update).
- **Edit re-computes stats based on new content** — so `char_count` reflects current content, not original. There's no historical record of what a message used to say.
- **Only populated for guilds with `analytics` feature flag enabled**. Almost certainly only Reactiflux at this stage. **Funnel-snapshot metrics computed from `message_stats` are not representative across the install base.**

---

## `mod_actions`

Authoritative record of moderation actions taken (kick / ban / unban / timeout / timeout_removed).

### Writers

- `app/models/modActions.ts:29` (`recordModAction`) — only writer. Inserts a new row.
- Called exclusively from `app/commands/report/modActionLog.ts:85` (`logModAction`).
- `logModAction` is called from `app/commands/report/modActionLogger.ts`:
  - `:65` — on `GuildBanAdd` (when a mod or external system bans).
  - `:107` — on `GuildBanRemove`.
  - `:194` — on `GuildMemberRemove`, *only after the audit log confirms it was a kick* (`fetchKickAuditLog`).
  - `:328`/`:338` — on `GuildMemberUpdate` for timeout applied or removed.

### Trigger conditions

A row is written when Discord emits a moderation gateway event AND the audit log confirms it within ~5 seconds AND it wasn't the bot itself doing it (the bot's own actions are skipped — see `modActionLogger.ts:57`, `:99`, `:159`, `:319`). Voluntary departures (a user leaving on their own) **do not** write a row.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id` | Always populated | UUID at insert. |
| `user_id`, `guild_id` [PII-id] | Always populated. |
| `action_type` | Always populated | `"ban" \| "unban" \| "kick" \| "timeout" \| "timeout_removed"`. |
| `created_at` | Always populated | ISO timestamp. |
| `executor_id` [PII-id] | Sometimes populated | Set from `auditEntry.executor.id`. **`null` if the audit log retry-loop (3 attempts × 500ms) didn't find a matching entry within 5s.** This happens for stealth/bulk actions, Discord audit-log propagation delays, or actions older than the lookup window. |
| `executor_username` [PII-content, mod username] | Sometimes populated | Same as `executor_id` — `null` when audit log lookup failed. |
| `reason` [PII-content, mod-supplied free text] | Sometimes populated | Set from audit log entry's `reason` field. The audit log handlers fall back to empty string `""` in some paths (`modActionLogger.ts:96`, `:172`) — so distinguish `NULL` from `""`. Many actions have no reason. |
| `duration` | Sometimes populated | Only set for `action_type="timeout"`. Always `null` for ban/kick/unban/timeout_removed. Format is a human-readable string like `"1 day"` (`formatDistanceToNowStrict`) — **not** an ISO-8601 duration. |

### Known gaps

- **MASSIVE GAP: automod-driven deletions are NOT in `mod_actions`.** `mod_actions` only records member-level actions (ban/kick/timeout). Spam messages that automod or the in-app spam-detection feature deletes are recorded in `reported_messages` with `reason="spam"` or `reason="automod"`, plus the per-message `deleted_at` field. To answer "spam messages auto-deleted last 30 days", **use `reported_messages WHERE reason IN ('spam', 'automod') AND deleted_at IS NOT NULL`**, not `mod_actions`.
- **Bot self-actions are skipped** (see filter at `modActionLogger.ts:57` etc.). Auto-kicks driven by the bot's spam-detection (`spamResponseHandler.ts:117` `member.kick(...)`) — these happen, but the corresponding `GuildMemberRemove` gateway event for that user is then filtered because the audit-log executor is the bot itself. **So `mod_actions` undercounts bot-driven enforcement.**
- **Automod timeouts (Discord-native automod) ARE recorded**, but with `executor_id=null` (see `modActionLogger.ts:315` — when `isAutomod=true`, the executor is forced to null to avoid misleading "rule creator did this" attribution).
- **First-recorded row is post-shipping the `mod_actions` table.** Per the kickoff brief, this table was added in early 2026 (cf. migrations). Older actions are not retroactively populated. Define cohorts accordingly.
- **`getRecentModActions` / `getModActionCounts`** functions exist for read-side analytics — useful for case-study scripts.

---

## `reactji_channeler_config`

Per-(guild, emoji) → forward-to-channel mappings.

### Writers

- `app/commands/setupReactjiChannel.ts:76` — slash-command setup; `onConflict (guild_id, emoji) doUpdateSet` (updates the target channel, threshold, configured_by_id).

### Trigger conditions

Admin runs `/setup-reactji-channel emoji:<x> [threshold:<n>]` in a channel. That channel becomes the destination; the (guild, emoji) becomes the trigger.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id` | Always populated | UUID at insert. |
| `guild_id`, `channel_id`, `configured_by_id`, `emoji` [PII-id, PII-content for emoji] | Always populated. |
| `created_at` | Always populated | `Generated<>` — uses SQLite default. |
| `threshold` | Always populated | `Generated<number>` default 1; writer passes `?? 1`. |

### Known gaps

- **No way to disable a mapping.** No delete path exists (`grep` confirms zero `deleteFrom("reactji_channeler_config")` calls). Once configured, the only path to "off" is to manually delete the row in SQLite or re-run setup pointing to a no-longer-existing channel (which will then fail at forward time).
- For "% of guilds using reactji-channeler" you can count distinct `guild_id`s — but you cannot know if it's an *active* config since usage isn't tracked here. (Usage events would be in PostHog via `featureStats.reactjiChannelSetup` and downstream events.)

---

## `reported_messages`

The audit log of every "this message is a problem" event — from anonymous `/report`, mod `/track`, automod-driven spam detection, and escalation resolution.

### Writers

- `app/models/reportedMessages.ts:53` (`recordReport`) — only insert path. Returns `{ wasInserted, result, reportId }`. **No `onConflict` clause; relies on caller-side dedup checks.**
- Callers of `recordReport`:
  - `app/commands/report/userLog.ts:176` — the primary path; called from `/report` (anonymous, `reason="anonReport"`), `/track` (mod-driven, `reason="track"`), spam-detection (`reason="spam"`), automod-detected log (`reason="automod"`), and mod-vote resolution (`reason="modResolution"`, though it's only referenced — verify the actual write path).
  - `app/features/spam/spamResponseHandler.ts:278` — back-fills prior duplicates when a sequence of messages is detected as spam (so they all share the same `log_message_id`/`log_channel_id`).
- `app/models/reportedMessages.ts:452` (`markMessageAsDeleted`) — sets `deleted_at` when the underlying Discord message is deleted. Called from:
  - `app/commands/track.ts:117` — "delete tracked message" button.
  - `app/features/spam/spamResponseHandler.ts:75` — spam-detection deletes the message.
  - `app/models/reportedMessages.ts:535` — bulk-delete called by `deleteAllReportedForUser` (which itself is invoked from "delete all messages from this user" mod action paths).
- `app/routes/export-data.tsx:193` — soft-deletes all reported_messages for a guild on data-deletion request (sets `deleted_at = now`).

### Trigger conditions

Driven by one of:
- **Anonymous user report** (`/report` slash → `reason="anonReport"`, `staff_id=null`).
- **Mod tracking** (`/track` slash → `reason="track"`, `staff_id=<mod-id>`, `staff_username=<mod-username>`).
- **In-app spam detection** (`spamResponseHandler.ts` → `reason="spam"`, `staff_id=<bot-user-id>`, `staff_username="Euno"` or similar — the bot user is passed as `staff`). Includes back-filled prior duplicates.
- **Discord-native automod detection** (`reason="automod"` — only seen in const definitions; verify a write path actually fires this; the `logAutomod` function in `app/commands/report/automodLog.ts` does NOT call `recordReport`, it only posts a Discord message). **Probably no production rows have `reason="automod"`; this enum value may be unused.**
- **Mod-vote resolution** (`reason="modResolution"`) — only referenced in `userLog.ts:104` for dedup-skip logic; **no write path triggers it currently** based on grep results. Treat this enum value as documented-but-unused.

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id` | Always populated | UUID at insert. |
| `reported_message_id`, `reported_channel_id`, `reported_user_id`, `guild_id` [PII-id] | Always populated. |
| `log_message_id`, `log_channel_id` [PII-id] | Always populated | Set from the Discord post made just before the DB insert. |
| `reason` | Always populated | One of `"anonReport"`, `"track"`, `"spam"`, `"modResolution"` (unused), `"automod"` (likely unused). |
| `created_at` | Always populated | `Generated<>` default; writer also passes ISO string. |
| `staff_id` [PII-id] | Sometimes populated | **`null` for anonymous reports** — this is the marker for anon and must not be joined to `users` for any published output. Set to the mod's ID for `/track` and to the bot's user ID for spam-detection-written reports. |
| `staff_username` [PII-content, mod username] | Sometimes populated | Same as `staff_id` — `null` for anon, otherwise set. |
| `extra` [PII-content, free-form spam-score summary] | Sometimes populated | `null` for `/report` and `/track`. Set for spam (`"Score 67 (high): summary text"`) and for back-filled prior duplicates (`"Back-filled prior duplicate. Score ..."`). |
| `deleted_at` | Sometimes populated | `null` until the message gets deleted. Set to ISO timestamp on delete (any path). |

### Known gaps

- **`reason="modResolution"` and `reason="automod"` enum values appear unused in writer code.** All productive writes use `anonReport`, `track`, or `spam`. Verify with Agent C's row counts; if zero rows exist for those reasons, mark them as dead enum values.
- **Anonymous-report anonymity depends on `staff_id IS NULL`.** Published outputs must filter on this — never join an anonymous-reasoned row to anything that identifies a user. This is the binding privacy constraint from the kickoff brief.
- **Spam reports include back-filled prior duplicates** — see `spamResponseHandler.ts:266–298`. So `COUNT(*) WHERE reason="spam"` overstates *unique* spam events: one detected spam message can yield 5+ rows (one per duplicate). The back-fill uses `extra LIKE 'Back-filled%'` as a marker; filter that out for "unique spam events".
- **`deleted_at` indicates DB-side "this was deleted on Discord" — not row deletion.** A row stays forever. Soft-delete pattern.
- **Spam-detection-as-staff is a category to watch.** Rows where `staff_id = <bot user id>` look superficially like "staff reported this" but are actually "bot auto-detected". For "manually-handled reports vs. auto-detected" metrics, you need to either filter on `reason` or on whether `staff_id` equals the bot's user ID.
- **Data-deletion soft-deletes ALL `reported_messages` in a guild.** If a guild ever requested data deletion, the entire `reported_messages` history for that guild has `deleted_at` set on the same date. Detect this pattern and exclude those guilds from time-bounded analyses where it matters.

---

## `sessions`

OAuth / web session storage. Not a domain table — purely operational for the React Router web app.

### Writers

- `app/models/session.server.ts:77` (`createData`) — insert on session creation.
- `app/models/session.server.ts:106` (`updateData`) — update on session data change.
- `app/models/session.server.ts:114` (`deleteData`) — delete on session destroy / logout.

### Trigger conditions

A row is written every time a user starts a new web session (lands on a page that touches session middleware). Sessions are deleted on logout. Expired sessions are not actively cleaned up — the cookie's `expires` field is set, but the row persists until logout or manual cleanup.

### Field reliability

`id` and `data` are populated (with `data` containing JSON of session contents including Discord token); `expires` is set if React Router decided on an expiry.

### Known gaps

- **Operational only.** Not relevant to case-study or funnel metrics.
- **`sessions.data` contains Discord OAuth tokens** — sensitive even in aggregate. Never expose row contents.
- No cleanup job: stale sessions accumulate. Could be useful for "active web-app users" but unreliable due to no expiry sweep.

---

## `tickets_config`

Per-(channel, message) → role mapping for the "open a private ticket" button.

### Writers

- `app/commands/setupTickets.ts:119` — `/tickets-channel` slash command inserts the row.
- `app/commands/setupTickets.ts:234` — fallback insert during the modal-submit path when a button exists with no corresponding config (legacy compatibility).
- `app/helpers/setupAll.server.ts:403` — web setup inserts a row.

### Trigger conditions

Admin runs `/tickets-channel` or web `/setup-all` with the tickets feature enabled. Each invocation creates a new ticket button → potentially multiple rows per guild (one per button posted).

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `message_id` [PII-id] | Always populated (PK). |
| `role_id` [PII-id] | Always populated | Falls back to `moderator` setting if no explicit `role` provided. |
| `channel_id` [PII-id] | Sometimes populated | **`null` if no explicit `channel` arg was passed to `/tickets-channel`** — see `setupTickets.ts:121` (`channel_id: ticketChannel?.id`). In that case tickets are created in whatever channel the button was clicked from. Web setup always provides an explicit channel. |

### Known gaps

- **No `guild_id` column.** Looking up "which guilds have tickets configured" requires joining via the Discord channel ID, which we can't do in SQL. To know whether a guild has tickets enabled, you'd need to walk `tickets_config.channel_id` → Discord API for each row — not feasible for analytics. **Recommend filing an instrumentation gap** for "which guilds have tickets enabled".
- **No `created_at`.** Can't cohort by time-to-tickets-activation.
- Multiple rows per guild possible (one button per call) — guild-distinct counts overstate "guilds with tickets".

---

## `users`

Web-app users (people who logged in via the dashboard), not Discord users. Identity layer.

### Writers

- `app/models/user.server.ts:104` (`createUser`) — inserts on first OAuth callback for a Discord user not yet in the table.
- `app/models/user.server.ts:130` (`deleteUserByEmail`) — deletes by email; only used for cleanup/testing.

### Trigger conditions

A row is created when a Discord user completes the OAuth login flow and we don't already have them (`session.server.ts:319–327`).

### Field reliability

| Column | Reliability | Notes |
|---|---|---|
| `id` | Always populated | `randomUUID()` at insert (not the Discord ID — that's `externalId`). |
| `externalId` [PII-id, Discord user ID] | Always populated. |
| `email` [PII-content] | Sometimes populated | Set from Discord OAuth response. Schema marks nullable; in practice always provided by Discord. |
| `authProvider` | Always populated | Hardcoded `"discord"` (`createUser:111`). |

### Known gaps

- **`users` ≠ Discord users.** A user that interacts with the bot via slash commands but never logs into the web app has no `users` row. So `users` row count is a tiny subset of bot interactors — useful for "active web-app users" only, not for community-wide measures.
- The user-level data-deletion path is documented in `export-data.tsx` but **deletes the guild-level data, not the user row** (see export-data.tsx:182 — "To delete your user account, please contact support."). So `users` rows are append-only in practice.

---

## `user_threads`

Per-user-per-guild moderation thread ID (where mod actions, reports, and tracking get posted privately).

### Writers

- `app/models/userThreads.ts:68` (`upsertUserThread`) — `insertInto("user_threads") onConflict(user_id, guild_id) doUpdateSet`. Sets `created_at` explicitly.

### Trigger conditions

A row is created the first time the bot needs to post a mod-private message about a user in a guild, via `getOrCreateUserThread`. Callers:

- `app/commands/report/modActionLog.ts:64` — every mod action (ban/kick/unban/timeout) routes through here.
- `app/commands/report/userLog.ts:89` — every report goes here.
- `app/commands/report/automodLog.ts:50` — every automod-detected event goes here.
- `app/discord/deletionLogger.ts:237` — when a mod deletes a message, the mod-deletion is also posted to the user's mod thread (not just the deletion-log thread).
- `app/commands/memberApplications.ts:301` and `:701` — application review thread posts.

### Field reliability

All four columns (`user_id`, `guild_id`, `thread_id`, `created_at`) [PII-id] are **always populated**.

### Known gaps

- **Existence of a row implies "this user has at least one moderation-relevant event in this guild"** — but the event types are heterogeneous (a single anonymous report creates a thread, as does a ban). Don't use row count as a proxy for any specific metric.
- **Threads are reused** — `upsertUserThread` updates the `thread_id` if the existing row's thread is no longer accessible (singleflight check in `doGetOrCreateUserThread`). So `created_at` is the most recent thread-creation time, not the original.

---

# Cross-cutting "known gaps" summary

The three most surprising / load-bearing traps for downstream metrics work:

1. **`message_stats` DELETES rows on Discord MessageDelete.** This means *every metric about deleted messages must come from somewhere else* — `reported_messages` for spam/track/automod, `mod_actions` for member-level actions. Counting "what got deleted" from `message_stats` will silently undercount because the deleted rows are gone.

2. **`mod_actions` skips bot-driven enforcement.** The bot filters its own actions out (`executor?.id === guild.client.user?.id`) on every gateway-event handler. So auto-kicks driven by the spam-detection feature, automod-rule kicks, etc. are missing from `mod_actions`. For "total enforcement", you need to UNION `mod_actions` with `reported_messages WHERE reason="spam"` (or accept the undercount). Conversely, Discord-native automod *timeouts* ARE recorded, but with `executor_id=null`.

3. **`reported_messages.staff_id IS NULL` is the privacy contract for anonymity.** This is the only marker. Joining anonymous rows to any user data — even indirectly via `reported_user_id` or `log_channel_id` — risks breaking the privacy promise. All downstream queries that touch `reported_messages` need to either filter anonymous rows out OR treat them as un-joinable.

# Smaller traps worth knowing

- `guild_subscriptions` records OAuth-completed installs, not "set up the bot" installs. The set difference (subscribed but never set up) is a real funnel-step.
- `escalations.resolution = "track"` is overloaded: zero votes, user-left, and "voted track" all produce the same value. Differentiate by joining `escalation_records`.
- `reported_messages` spam rows include back-filled duplicates (`extra LIKE 'Back-filled%'`) which inflate counts.
- `reason="modResolution"` and `reason="automod"` enum values look defined but **have no current writer path** — verify with Agent C's row counts before relying on them.
- `applications.reviewed_by` is `null` for auto-denied-on-departure rows — filter on it for "actively reviewed" metrics.
- `channel_info` and `application_config` lack `created_at` columns; can't cohort by feature-activation date for those features without external data.
- `tickets_config` has no `guild_id` column — can't easily ask "which guilds enabled tickets" from SQL alone.

# Writers that I couldn't fully trace (follow-up flags)

- **Stripe webhook handlers**: `subscriptions.server.ts` exposes `createOrUpdateSubscription` / `updateSubscriptionStatus`, and `stripe.server.ts` has `constructWebhookEvent`, but I didn't find the route handler that wires webhooks → these methods. Need to look at `app/routes/` (likely `stripe.webhook.tsx` or similar) to confirm exactly which Stripe events cause `guild_subscriptions` writes and what they set `status` / `current_period_end` to. Important for trial→paid conversion attribution.
- **`reported_messages` `reason="modResolution"` / `"automod"`** — these enum values exist; the writer path for them is not visible in my grep. May be dead code or invoked indirectly through paths I didn't recurse into. Worth a fast check against actual row counts (Agent C) and a `git log -S 'modResolution'` audit.
- **`channel_info` initial population**: there's no migration-time seed I could find; rows accumulate only as the activity tracker encounters new channels. Confirm with row counts whether older channels are missing (and if so, channel-category-based analytics undercount messages in those channels because `channel_category` defaults to `null`).
