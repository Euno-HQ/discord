# Per-feature flag gating — execution log

**Date:** 2026-05-26
**Branch:** `feature/per-feature-flag-gating`
Executing `2026-05-26_2_per-feature-flag-gating-plan.md` via subagent-driven-development.

## Task 1 — PostHog flags created (DONE)

All three clone the `escalate` flag (id 532964) filter exactly: 3 OR'd group-level
conditions, `aggregation_group_type_index: 0`, `active: true`, `evaluation_runtime: all`.

| Flag key | PostHog flag id |
|---|---|
| `velocity-spam` | 691228 |
| `member-applications` | 691230 |
| `data-export` | 691233 |

Filter groups (all three):
1. `subscription_tier=paid` AND `subscription_status=active` (group), rollout 100
2. `comped is_set` (group), rollout 100
3. `id = 822583790773862470` exact (group, dev/owner guild), rollout 100

These existed BEFORE enforcement code ships — the critical ordering constraint, so paid
guilds never lose access.

## Execution approach

- Implementer subagents (one per code task) do TDD + commit.
- Spec compliance verified by controller against the plan (controller holds the authoritative plan).
- Code quality reviewed by a dedicated reviewer subagent per task.
- Final full-branch review after Task 10.
- No push / PR without owner go-ahead.

## Tasks 2–9 complete (DONE) — commits on `feature/per-feature-flag-gating`

Base: `e848b44`. 9 commits, 14 files (+277/−134):

| Commit | Task |
|---|---|
| `f864927` | T2 — add 3 keys to `BooleanFlag` + decode test |
| `ea80cb0` | T3 — `syncGuildGroup` + wire into 3 Stripe handlers + payment.success (fail-soft) |
| `d7d8b6a` | T4 — `AppRuntime.isFeatureEnabled` Promise bridge |
| `810fc37` | T5 — gate data export on `data-export` (kept `SubscriptionService` import — still used for the export body) |
| `1f7e161` | T6 — gate ticket creation on `ticketing` |
| `d787af7` | T7 — gate member applications on `member-applications` |
| `37ca54e` | T8 — TTL-cached `velocityGate.ts` + 5 tests; spam layer gets `FeatureFlagServiceLive` |
| `e069641` | T9 — remove dead `TierFlag`/`checkTier`/`isTierEnabled`/`requireTierFeature`/`PAID_FEATURES` + `hasFeature` |
| `7ef4112` | regression fix — stub `subscriptions.server` in `memberApplications.test` (import cycle) |

### Review notes / decisions
- **T3 review (fixed):** `groupIdentify` was a sync call in `Effect.gen`; a throw → defect → would reject `runEffect` → 400 the Stripe webhook (retry storm) or 500 the post-payment redirect. Wrapped in `Effect.try().pipe(catchAll(log))` → fully fail-soft. Also added an N+1-at-startup acknowledgment comment (`initializeGroups` now does per-guild `getGuildSubscription`; accepted, startup-only).
- **T8 review (fixed):** added a per-guild cache-isolation test. Rejected a reviewer "double-instantiation" flag as a false positive — Effect memoizes layers by reference within one `ManagedRuntime` build, and the proposed fix would have leaked `DatabaseService|FeatureFlagService` into `AppLayer`'s requirement channel.
- **T8 design:** `FeatureFlagService` resolved once in the `Layer.effect` constructor and closed over, so `checkMessage` keeps `R = never` (satisfies `ISpamDetectionService`). `velocityGate.ts` takes `IFeatureFlagService` as a plain param (type-only import) → unit-testable with no Tag/mock infra.

### Import-cycle landmine (FOLLOW-UP, not blocking)
Adding `FeatureFlagService` to `memberApplications.ts` exposed a pre-existing module-load cycle:
`featureFlags → posthog → subscriptions.server → AppRuntime` (AppRuntime eagerly builds `AppLayer` via top-level `await`). Loading the command module in a test first-touched `featureFlags`, reaching AppRuntime mid-cycle → `FeatureFlagServiceLive` undefined → layer build crash. Safe in production (all AppRuntime-derived bindings in the cycle are dereferenced only inside async/lazy bodies, never at module eval). Fixed test-side by stubbing `subscriptions.server`.
- **Recommended follow-up:** make `posthog.ts`'s `SubscriptionService` import a lazy `import()` inside `syncGuildGroup` to eliminate the static cycle edge entirely, so future test files don't need the stub. (Opus final review concurred — non-blocking.)

### Validation
`npm run validate` → 348 tests pass (34 files), typecheck clean, lint 0 errors (one pre-existing unrelated `constructLog.ts` warning). Final full-branch review (opus): **READY TO MERGE**, no Critical/Important issues.

### Remaining (gated on owner)
- Manual verification checklist (free / paid / comped / dev-allowlist guilds; sync-without-restart) — needs a running bot + PostHog.
- Push + open merge-commit PR into `main` — **owner go-ahead required.** PR body must state the behavior change: free guilds lose ticketing/velocity/applications/export unless paid, comped, or the allowlisted dev guild.
