# SQLite Indexes and Pragma Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing indexes on `message_cache` that the expiry queries actually use, prove each with `EXPLAIN QUERY PLAN`, and settle the `foreign_keys` and `synchronous` pragma questions with evidence rather than folklore.

**Architecture:** One additive kysely-ctl migration (two `CREATE INDEX`, both on `message_cache`). No application code changes. Pragma findings are documentation only unless Carl picks `synchronous=NORMAL`.

**Tech Stack:** SQLite via `node:sqlite` (`@effect/sql-sqlite-node` 4.0.6), kysely-ctl migrations (better-sqlite3 driver), vitest.

**Source:** arch-review rec #2. Note: the review file (`.../scratchpad/arch-review.md`) did not exist when this plan was written, so every claim below is re-derived from the current tree.

**Assumes landed first (not planned here):** job-runner drain loop; lifecycle hardening.

**Scope change:** the Star Hunter dashboard and its analytics queries (`activity.server.ts`, `cohortAnalysis.ts`) were deleted from this branch, and there is no analytics worker thread. The `message_stats` indexes in the first draft were justified only by those queries, so they are dropped (see Design). An earlier draft of this plan listed four indexes.

---

## Context: what the code actually does

### Existing indexes

`message_stats` has only its primary key (`message_id`), created in `migrations/20240906155529-message_stats.ts:5-17`. The two later migrations only `alterTable` it (`20250531210224-message_code_stats.ts:7`, `20250612220730_message_links.ts:7`). No migration creates an index on it. `message_cache` likewise has only its PK (`migrations/20260218000000_message_cache.ts:5-13`). Every non-PK query below therefore full-scans its table.

### Query shapes (all read in the current tree)

| Query | Where | Predicate / shape | Index-relevant? |
|---|---|---|---|
| `message_stats` insert | `app/discord/pipelines/activityTrackerHandlers.ts:45` | one insert per tracked message | write cost only |
| `message_stats` edit / reaction add / reaction remove / delete | `activityTrackerHandlers.ts:90,123,146,171` | all `WHERE message_id = ?` | no, uses the PK |
| data export | `app/routes/export-data.tsx:95-102` | `WHERE guild_id = ? LIMIT 1000` | scan, user-initiated, rare |
| guild data delete | `app/routes/export-data.tsx:211` | `DELETE ... WHERE guild_id = ?` | scan, user-initiated, one-off |
| content expiry (every 10 min) | `app/discord/messageCacheService.ts:110-127` | `UPDATE message_cache SET content = NULL WHERE content IS NOT NULL AND last_touched < ?` | yes |
| row expiry (every 10 min) | `messageCacheService.ts:129-137` | `DELETE FROM message_cache WHERE created_at < ?` | yes |

Grep for `message_stats` across `app/` (excluding `db.d.ts`) finds only `activityTrackerHandlers.ts` (+ its test) and `export-data.tsx`; there are no other readers, and no reader filters on `sent_at`, `author_id` or `channel_id`.

The 10-minute cadence comes from `messageCacheExpirationSchedule` (`messageCacheService.ts:149-157`, `10 * 60 * 1000` at line 151).

`message_cache` point lookups by `message_id` (`messageCacheService.ts:95-103`) use the PK and need nothing.

---

## Design

### Indexes (only ones a query above uses)

| Index | Serves | Evidence |
|---|---|---|
| `idx_message_cache_created_at (created_at)` | row-expiry `DELETE` (`messageCacheService.ts:129-133`) | EXPLAIN below |
| `idx_message_cache_last_touched (last_touched) WHERE content IS NOT NULL` | content-expiry `UPDATE` (`messageCacheService.ts:110-120`) | EXPLAIN below |

Why the last one is partial: the query only ever wants rows that still hold content, and expiry nulls them, so the partial index shrinks as it is consumed. SQLite uses a partial index only when the query's `WHERE` implies the index's; the query has the literal `content IS NOT NULL` (`messageCacheService.ts:117`), so it does.

Write cost: `message_cache` already has three writers (`messageCacheService.ts:59,85,115`); `last_touched` is rewritten on touch (line 86), so that index adds an update per touch. Inference: small next to the Discord round-trips around them, and the table is bounded to roughly 24 h of rows (`messageCacheService.ts:130`).

**Not proposed: any `message_stats` index.** The only remaining non-PK queries are the export (`WHERE guild_id = ? LIMIT 1000`, `export-data.tsx:95-102`) and the guild delete (`export-data.tsx:211`). Both are user-initiated and rare, and a full scan of the table once per such request is acceptable. An index on `guild_id` would add a B-tree insert to `activityTrackerHandlers.ts:45` for every tracked message (the hottest write path) to speed two cold paths. No remaining query filters on `sent_at`, `author_id` or `channel_id`. Revisit only if production shows the export or delete scan is slow (open question 1); the fix then is a single `(guild_id)` index.

### Verified plans

Prototype run on a synthetic 20k-row `message_cache` in `node:sqlite` (Node 24.15), with `ANALYZE`. The local `mod-bot.sqlite3` is a 0-byte file, so there is no real data to profile. These are the plans from the first draft's prototype for the two `message_cache` statements; re-run them in Task 1 against the compiled SQL because the prototype predates the scope change.

```
BEFORE  cache expiry x2  SCAN message_cache
AFTER   content expiry   SEARCH message_cache USING INDEX idx_last_touched (last_touched<?)
        row expiry       SEARCH message_cache USING INDEX idx_created_at (created_at<?)
```

For reference, export and delete on `message_stats` stay `SCAN message_stats` by design (no index proposed). Nothing in `app/` runs `ANALYZE` (grep for `ANALYZE`/`PRAGMA` in `app/` finds only the integrity and checkpoint pragmas, `app/Database.ts:110,147`), so do not design around planner statistics.

### Migration format

Copy `migrations/20260322000000_background_jobs.ts` (its `createIndex` is at line 25): `Kysely<any>`, `db.schema.createIndex(name).on(table).columns([...]).execute()`, and a `down` that drops them. The partial index needs `.where(sql.ref("content"), "is not", null)` (kysely supports `where` on `createIndex` for SQLite; verify against kysely 0.28 types) or a raw `sql\`CREATE INDEX ... WHERE content IS NOT NULL\``. Prefer the raw form with `IF NOT EXISTS`, which also makes a retried migration safe.

Indexes do not change the generated schema, so `app/db.d.ts` (regenerated by the hook) should show no diff. If it does, something else changed.

---

## Pragma evaluation

### `PRAGMA foreign_keys = ON`: already on, and nothing to enforce

Two facts, both checked:

1. **No FOREIGN KEY is declared anywhere.** `grep -riE "foreign|references|onDelete|cascade" migrations/` has no matches in the current tree. Relationships (`guild_id`, `author_id`, `channel_id` columns) are by convention, not constraint.
2. **The pragma is already ON for both drivers.** On this machine `new DatabaseSync(':memory:')` and `better-sqlite3` both report `foreign_keys = 1`. node:sqlite's `enableForeignKeyConstraints` option defaults to true, and `@effect/sql-sqlite-node` constructs `DatabaseSync` with only `readOnly` and `allowExtension` (`node_modules/@effect/sql-sqlite-node/src/SqliteClient.ts:152-155`), so it keeps the default. It only sets `busy_timeout` and `journal_mode=WAL` (lines 170-196).

So the premise "node:sqlite needs it set per connection" is the right rule for SQLite in general, but unnecessary here: the app connection (`makeDatabaseLayer`, `app/Database.ts:95`) inherits the default.

**Recommendation: do not add FKs now.** Adding them is a table-rebuild migration per table (SQLite cannot `ALTER ... ADD CONSTRAINT`), and the first FK that rejects a Discord-sourced write (a message from a guild we have not onboarded yet) turns an ignorable data gap into a handler failure. If Carl wants FKs later:

1. Check existing data first: `PRAGMA foreign_key_check;` returns one row per violation (table, rowid, parent, fkid). It is a no-op today because no FKs exist, so run it against a copy of production *after* the candidate schema is built in a scratch DB, not before.
2. Rebuild per SQLite's 12-step procedure inside a migration, with `PRAGMA foreign_keys=OFF` outside the transaction (the pragma is a no-op inside one) and `foreign_key_check` before commit.
3. Pin `enableForeignKeyConstraints` explicitly in any additional connection so a driver default change cannot silently flip behavior. Add one test asserting `PRAGMA foreign_keys` is 1 on the app connection so the default is a checked fact.

### `PRAGMA synchronous = NORMAL` under WAL

SQLite's default is `FULL` (confirmed: node:sqlite reports `synchronous = 2`; the driver does not change it). In WAL mode, `FULL` fsyncs the WAL on every commit; `NORMAL` fsyncs only at checkpoint. The tradeoff: with `NORMAL`, a power loss or OS crash can lose the most recently committed transactions (the database stays consistent and uncorrupted, you only lose the tail), while an application crash or `SIGKILL` loses nothing because the data is already in the OS page cache. The pod risk model is mostly the latter, and the bot's writes (message stats, caches) are re-derivable or low value, but `mod_actions`, reports and escalation votes are not. Gain: commit latency drops from an fsync to a `write()`, which matters because writes are serialized on one connection (driver docs: "single serialized connection", `SqliteClient.ts:131`). **Recommendation: leave `FULL` until a measured commit-latency problem exists**; this plan does not change it. The checkpoint is also run on shutdown (`checkpointWal`, `app/Database.ts:107-112`), which already limits tail loss on graceful stops. Setting it, if chosen, belongs in `makeDatabaseLayer` as `sql.unsafe("PRAGMA synchronous = NORMAL")` after client construction, and is per-connection.

---

## Production risk: building indexes at boot

Container start is `sh -c "npm run start:migrate; exec node ./index.prod.js"` (`Dockerfile:45`; `package.json:27` for `start:migrate`). Migrations run before the web server listens, using a separate better-sqlite3 connection from `kysely.config.ts:8-10`.

**Impact estimate.** Only `message_cache` is indexed now, and it is bounded to roughly 24 h of messages (`messageCacheService.ts:130`), so both builds are expected to be sub-second. (The first draft measured 0.8-1.3 s per 2M-row `message_stats` index on a laptop SSD; those indexes are no longer proposed, so that estimate no longer applies.) Unknown: the real `message_cache` row count.

**Who is blocked.** `CREATE INDEX` holds the write lock for the whole build. Readers continue under WAL. But at boot the old pod is gone (1-replica StatefulSet, `cluster/deployment.yaml:10`, `RollingUpdate` at line 17 deletes before recreating; inference from StatefulSet semantics), and the new process has not started yet, so no app writer exists. The practical costs are:

- **Startup probe budget.** `startupProbe` allows 30 x 2 s = 60 s (`cluster/deployment.yaml:43-48`) and the clock starts at container start, so migration time eats it. Beyond roughly 60 s of build (not expected here), Kubernetes kills the container mid-migration. SQLite rolls back the partial `CREATE INDEX`, so the failure mode is a restart loop, not corruption.
- **`;` not `&&`.** If the migration throws, the bot starts anyway on the old schema (`Dockerfile:45`, `;` between the commands). A failed index migration is therefore non-fatal but silent; the bot just stays slow. Check the migrate log line.

**Mitigation:** none needed at the expected size. If the UAT migration log shows the build is slow, build by hand with `sqlite3` on the pod before deploying (`CREATE INDEX IF NOT EXISTS ...`); the migration then no-ops. This is why the migration uses that form.

---

## Tasks

### Task 1: Measure on a production-shaped copy

**Files:** none (scratch work in the scratchpad dir only)

- [ ] **Step 1:** On the pod or a snapshot, record `SELECT count(*) FROM message_cache` (and `message_stats`, for open question 1), file size, and the page count (`PRAGMA page_count`).
- [ ] **Step 2:** On a copy, capture `EXPLAIN QUERY PLAN` for the two `message_cache` expiry statements (and the export and delete statements, to confirm they scan) before the change. Use the compiled SQL (`query.compile().sql`) not hand-written SQL, so the plan matches the app.
- [ ] **Step 3:** Time the two expiry statements on the copy, pre-index, as the baseline.

### Task 2: The migration

**Files:**
- Create: `migrations/20261029000000_message_indexes.ts`
- Test: `migrations/messageIndexes.test.ts` (or alongside existing migration tests if one exists; none seen, so this is new)

- [ ] **Step 1: Write the failing test.** Apply all migrations to `:memory:` up to the previous one, assert `PRAGMA index_list('message_cache')` has only the PK autoindex, then apply the new one and assert the two index names exist.
- [ ] **Step 2:** Write `up` with `CREATE INDEX IF NOT EXISTS` for both (raw `sql` for the partial one) and `down` with `DROP INDEX IF EXISTS`.
- [ ] **Step 3:** Run `npx vitest run migrations/messageIndexes.test.ts`, expect pass.
- [ ] **Step 4:** Run `npm run kysely migrate:latest` against a throwaway `DATABASE_URL`, then `generate:db-types`; confirm `app/db.d.ts` has no diff.

### Task 3: Plan regression test

**Files:**
- Create: `app/discord/messageCacheService.indexes.test.ts`

- [ ] **Step 1:** Using the migrated in-memory DB, compile the two `message_cache` expiry statements (`query.compile()`), run `EXPLAIN QUERY PLAN`, and assert the detail text contains `idx_message_cache_last_touched` / `idx_message_cache_created_at`. This pins the "only ones a query uses" claim: if someone rewrites a query so the index stops applying, the test fails.
- [ ] **Step 2:** Run it; expect pass. Insert enough rows (a few thousand, mixing NULL and non-NULL `content`) and run `ANALYZE` in setup so the planner prefers the index over a scan.

### Task 4: Verify and release notes

- [ ] **Step 1:** `npm run typecheck`, `npm run lint`, `npx vitest run`.
- [ ] **Step 2:** Add a line to the RC checklist (`.github/workflows/release-candidate.yml:145` already has "DB migrations run cleanly") noting the index build time observed on UAT.

---

## Risks and rollback

- **Slow first boot:** not expected (small table, see above). Rollback is `down` (drop the indexes) via `kysely migrate:down`, or ship a revert migration; dropping an index is instant.
- **Planner skips the partial index.** Mitigated by Task 3 and `ANALYZE` in test setup. Optionally run `PRAGMA optimize` at shutdown; not planned.
- **Write amplification** on `message_cache`: one extra B-tree update on touch. No change to the `message_stats` insert path, which is the point of dropping those indexes.
- **Disk growth:** negligible; the indexes cover at most about 24 h of cache rows. The PVC is 1Gi (`cluster/deployment.yaml:80`); that headroom matters only if someone later adds a `message_stats` index.
- Nothing here touches versions or deploys; Carl cuts the release.

## Open questions for Carl

1. What is the production row count and file size of `message_stats`? No index is planned, so this only matters if the data export or guild delete (`export-data.tsx:95-102,211`) is observed to be slow, in which case add a single `(guild_id)` index.
2. Do you want `synchronous = NORMAL`? My recommendation is no until commit latency is measured; say so if you want it anyway.
3. Do you want FKs at all? My recommendation is no (no declared FKs today, rebuild migrations are costly, Discord data arrives out of order).
