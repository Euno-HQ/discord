# Per-feature PostHog flag gating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four `premium_moderation` features (escalation, ticketing, velocity spam, member applications) plus data export gate on per-feature PostHog flags, and retire the dead DB-backed entitlement paths.

**Architecture:** Each paid feature gets a PostHog boolean flag whose release conditions read the `guild` group's `subscription_tier`/`subscription_status` properties (already projected from the DB by `posthog.ts:initializeGroups`). Code checks the flag via the existing `FeatureFlagService.isPostHogEnabled`. Billing stays in Stripe→DB; the DB is only projected onto the PostHog group. The DB-direct `TierFlag`/`hasFeature` entitlement code is removed.

**Tech Stack:** TypeScript, Effect-TS, discord.js, Kysely (SQLite), React Router v7, PostHog (`posthog-node`), vitest. **Consult `notes/EFFECT.md` before editing Effect code.**

**Branch:** `feature/per-feature-flag-gating` (off `main`). PRs to `main` use merge commits. Do not push without the owner's go-ahead.

**Commands:**
- Run one test file: `npx vitest run <path>`
- Typecheck: `npm run typecheck` (`react-router typegen && tsc -b`)
- Lint: `npm run lint`
- Everything: `npm run validate`

**Critical ordering:** Task 1 (create flags) MUST land before the enforcement tasks deploy. A flag that doesn't exist evaluates to `false`, which would deny the feature to *every* guild including paying ones. Within this branch, do Task 1 first.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| (PostHog project) | Three new flag definitions | Create via MCP |
| `app/effects/featureFlags.ts` | Flag keys + service; remove dead tier code | Modify |
| `app/effects/featureFlags.test.ts` | Service tests; update mock | Modify |
| `app/effects/posthog.ts` | Extract `syncGuildGroup(guildId)` | Modify |
| `app/routes/webhooks.stripe.tsx` | Re-sync group on subscription change | Modify |
| `app/routes/payment.success.tsx` | Re-sync group after upgrade | Modify |
| `app/AppRuntime.ts` | `isFeatureEnabled` Promise bridge; spam layer dep | Modify |
| `app/routes/export-data.tsx` | Gate export on `data-export` flag | Modify |
| `app/commands/setupTickets.ts` | Gate `open-ticket` on `ticketing` flag | Modify |
| `app/commands/memberApplications.ts` | Gate `apply-to-join` on `member-applications` flag | Modify |
| `app/features/spam/velocityGate.ts` | TTL-cached velocity flag gate | Create |
| `app/features/spam/velocityGate.test.ts` | Gate unit tests | Create |
| `app/features/spam/service.ts` | Use the gated velocity signals | Modify |
| `app/models/subscriptions.server.ts` | Remove `hasFeature` + inline `PAID_FEATURES` | Modify |

---

## Task 1: Create the three PostHog flags

No code. Uses the PostHog MCP. Each flag clones the `escalate` filter exactly (verified from flag id 532964): three OR'd group-level conditions, `aggregation_group_type_index: 0`.

- [ ] **Step 1: Create `velocity-spam`**

```
call create-feature-flag {"key":"velocity-spam","name":"Velocity & raid spam detection (paid: premium_moderation)","active":true,"filters":{"aggregation_group_type_index":0,"groups":[{"properties":[{"key":"subscription_tier","type":"group","group_type_index":0,"value":["paid"],"operator":"exact"},{"key":"subscription_status","type":"group","group_type_index":0,"value":["active"],"operator":"exact"}],"rollout_percentage":100,"aggregation_group_type_index":0},{"properties":[{"key":"comped","type":"group","group_type_index":0,"operator":"is_set"}],"rollout_percentage":100,"aggregation_group_type_index":0},{"properties":[{"key":"id","type":"group","group_type_index":0,"value":["822583790773862470"],"operator":"exact"}],"rollout_percentage":100,"aggregation_group_type_index":0}]}}
```

- [ ] **Step 2: Create `member-applications`** — same JSON, with `"key":"member-applications"` and `"name":"Member applications (paid: premium_moderation)"`.

- [ ] **Step 3: Create `data-export`** — same JSON, with `"key":"data-export"` and `"name":"Data export (paid)"`.

- [ ] **Step 4: Verify** — `call feature-flag-get-all {"search":"velocity-spam"}` (repeat for the other two). Expected: each returns one flag, `active: true`, three filter groups. Also confirm with `feature-flag-get-definition` that group 1 has `subscription_tier=paid` + `subscription_status=active`.

No commit (external state).

---

## Task 2: Add the new keys to the `BooleanFlag` union

**Files:**
- Modify: `app/effects/featureFlags.ts:14-21`
- Test: `app/effects/featureFlags.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `app/effects/featureFlags.test.ts` (top-level, after imports):

```ts
import { Schema } from "effect";
import { BooleanFlag } from "./featureFlags";

describe("BooleanFlag", () => {
  test.each(["velocity-spam", "member-applications", "data-export"])(
    "accepts %s",
    (key) => {
      expect(Schema.decodeUnknownSync(BooleanFlag)(key)).toBe(key);
    },
  );
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run app/effects/featureFlags.test.ts`
Expected: FAIL — the three new keys are not yet members of `BooleanFlag`.

- [ ] **Step 3: Add the keys**

In `app/effects/featureFlags.ts`, extend the literal (currently lines 14-21):

```ts
export const BooleanFlag = Schema.Literal(
  "mod-log",
  "anon-report",
  "escalate",
  "ticketing",
  "analytics",
  "deletion-log",
  "velocity-spam",
  "member-applications",
  "data-export",
);
export type BooleanFlag = typeof BooleanFlag.Type;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run app/effects/featureFlags.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/effects/featureFlags.ts app/effects/featureFlags.test.ts
git commit -m "feat: add velocity-spam, member-applications, data-export to BooleanFlag"
```

---

## Task 3: Extract `syncGuildGroup` and re-sync on subscription change

The Stripe webhook updates the DB but never re-runs `groupIdentify`; `initializeGroups` only runs at bot startup (`server.ts:173`). So a guild that upgrades won't have its `subscription_tier` group property updated until restart, and flags won't flip. Extract a single-guild sync and call it on every subscription write.

**Files:**
- Modify: `app/effects/posthog.ts`
- Modify: `app/routes/webhooks.stripe.tsx`
- Modify: `app/routes/payment.success.tsx`

- [ ] **Step 1: Add `syncGuildGroup` to `app/effects/posthog.ts`**

Add this exported helper (and refactor `initializeGroups` to call it). It mirrors the existing `groupIdentify` block (lines 56-66) but for one guild, and pulls the subscription itself:

```ts
import { type Guild } from "discord.js";

/** Re-project one guild's subscription state onto its PostHog group so flag
 *  evaluation reflects the current tier without waiting for a bot restart. */
export const syncGuildGroup = (guildId: string, guild?: Guild) =>
  Effect.gen(function* () {
    const posthog = yield* PostHogService;
    if (!posthog) return;

    const sub = yield* Effect.tryPromise(() =>
      SubscriptionService.getGuildSubscription(guildId),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    posthog.groupIdentify({
      groupType: "guild",
      groupKey: guildId,
      properties: {
        id: guildId,
        ...(guild
          ? { name: guild.name, member_count: guild.memberCount }
          : {}),
        subscription_tier: sub?.product_tier ?? "free",
        subscription_status: sub?.status ?? "none",
      },
    });
  });
```

Then in `initializeGroups`, replace the inline `posthog.groupIdentify({...})` loop body (lines 56-66) with a call to the new helper:

```ts
    for (const [guildId, guild] of guilds) {
      yield* syncGuildGroup(guildId, guild);
    }
```

> Note: `SubscriptionService.getGuildSubscription` returns the row including
> `product_tier` and `status` (see `subscriptions.server.ts`). Confirm the field
> names against that file before finalizing.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` → passes. (`syncGuildGroup` is referenced by `initializeGroups`.)

- [ ] **Step 3: Wire into the webhook handlers**

In `app/routes/webhooks.stripe.tsx`, after EACH `await SubscriptionService.createOrUpdateSubscription({...})` call (in `handleCheckoutSession` ~line 128, `handleSubscriptionUpdated` ~line 179, `handleSubscriptionDeleted` ~line 218), add a group re-sync. Import the runtime bridge + helper at the top:

```ts
import { runEffect } from "#~/AppRuntime";
import { syncGuildGroup } from "#~/effects/posthog";
```

and after each subscription write:

```ts
  await runEffect(syncGuildGroup(guildId));
```

- [ ] **Step 4: Wire into `payment.success.tsx`**

In `app/routes/payment.success.tsx`, after the `await SubscriptionService.createOrUpdateSubscription({...})` (line 32-39) and before the `redirect` (line 41):

```ts
  const { runEffect } = await import("#~/AppRuntime");
  const { syncGuildGroup } = await import("#~/effects/posthog");
  await runEffect(syncGuildGroup(guildId));
```

(Use a static top-of-file import instead if the file has no constraint against it; the existing imports are static, so prefer static imports matching the file's style.)

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint` → passes.

- [ ] **Step 6: Commit**

```bash
git add app/effects/posthog.ts app/routes/webhooks.stripe.tsx app/routes/payment.success.tsx
git commit -m "fix: re-sync guild PostHog group on subscription change"
```

---

## Task 4: Add `isFeatureEnabled` Promise bridge to `AppRuntime`

The web route (`export-data.tsx`) is async/await, not Effect. Add a thin bridge so it can check a flag.

**Files:**
- Modify: `app/AppRuntime.ts`

- [ ] **Step 1: Add the helper**

In `app/AppRuntime.ts`, after `runEffect` (around line 95), add:

```ts
/** Promise bridge: evaluate a PostHog flag for a guild from async/await code. */
export const isFeatureEnabled = (
  flag: BooleanFlag,
  guildId: string,
): Promise<boolean> =>
  runEffect(
    Effect.flatMap(FeatureFlagService, (flags) =>
      flags.isPostHogEnabled(flag, guildId),
    ),
  );
```

`Effect`, `FeatureFlagService`, and `BooleanFlag` are already imported at the top of this file (lines 1, 9-12).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` → passes.

- [ ] **Step 3: Commit**

```bash
git add app/AppRuntime.ts
git commit -m "feat: add AppRuntime.isFeatureEnabled Promise bridge"
```

---

## Task 5: Gate data export on the `data-export` flag

**Files:**
- Modify: `app/routes/export-data.tsx:1-44`

- [ ] **Step 1: Replace the DB check with the flag check**

Change the import on line 1 region to add `isFeatureEnabled` and drop the `SubscriptionService` import if it becomes unused (it is — its only use here is the gate):

```ts
import { db, isFeatureEnabled, run, runTakeFirst } from "#~/AppRuntime";
```

Replace lines 26-44 (the `if (guildId) { const hasAccess = await SubscriptionService.hasFeature(...) ... }` block) with:

```ts
      if (guildId) {
        const hasAccess = await isFeatureEnabled("data-export", guildId);

        if (!hasAccess) {
          return new Response(
            JSON.stringify({
              error:
                "Data export is a paid feature. Please upgrade your subscription.",
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
```

> If `SubscriptionService` is still referenced elsewhere in this file (e.g. the
> delete path at line ~203 uses `db.deleteFrom`, not `SubscriptionService`),
> remove only the now-unused import. Run lint to confirm no-unused-vars.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint` → passes (no unused `SubscriptionService` import).

- [ ] **Step 3: Commit**

```bash
git add app/routes/export-data.tsx
git commit -m "feat: gate data export on data-export PostHog flag"
```

---

## Task 6: Gate ticket creation on the `ticketing` flag

The `open-ticket` button handler (`setupTickets.ts:156-185`) currently shows the ticket modal unconditionally. Gate it: a member on a non-paid guild gets a friendly ephemeral message instead of the modal.

**Files:**
- Modify: `app/commands/setupTickets.ts:156-185`

- [ ] **Step 1: Add the gate to the `open-ticket` handler**

At the top of the `Effect.gen` body in the `open-ticket` handler (before constructing the modal, currently line 160), insert:

```ts
        const flags = yield* FeatureFlagService;
        const enabled = yield* flags.isPostHogEnabled(
          "ticketing",
          interaction.guildId!,
        );
        if (!enabled) {
          yield* interactionReply(interaction, {
            content: "Ticketing isn't enabled on this server.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
```

Add the import at the top of the file (alongside the other `#~/effects` imports):

```ts
import { FeatureFlagService } from "#~/effects/featureFlags";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` → passes. (Command handlers run within the `AppLayer` runtime, which provides `FeatureFlagService` — see `AppRuntime.ts:32`. The handler effect now requires `FeatureFlagService` in `R`; this is satisfied by the runtime.)

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add app/commands/setupTickets.ts
git commit -m "feat: gate ticket creation on ticketing flag"
```

> Verification note (manual, later): the `modal-open-ticket` submit handler
> (line 188) is a separate interaction. Gating the button is sufficient because
> the modal can only be opened through the gated button. No second gate needed.

---

## Task 7: Gate member applications on the `member-applications` flag

The `apply-to-join` button handler (`memberApplications.ts:104-173`) shows the application modal unconditionally. Gate it the same way.

**Files:**
- Modify: `app/commands/memberApplications.ts:104-173`

- [ ] **Step 1: Add the gate**

In the `apply-to-join` handler's `Effect.gen` body, immediately after the opening `Effect.gen(function* () {` (line 111) and before the duplicate-application check (line 113), insert:

```ts
        const flags = yield* FeatureFlagService;
        const enabled = yield* flags.isPostHogEnabled(
          "member-applications",
          interaction.guildId!,
        );
        if (!enabled) {
          yield* interactionReply(interaction, {
            content: "Applications aren't enabled on this server.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
```

Add the import at the top of the file:

```ts
import { FeatureFlagService } from "#~/effects/featureFlags";
```

(Confirm `interactionReply` and `MessageFlags` are already imported in this file — they are used elsewhere in it. If not, import `interactionReply` from `#~/effects/discordSdk.ts` and `MessageFlags` from `discord.js`.)

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint` → passes.

- [ ] **Step 3: Commit**

```bash
git add app/commands/memberApplications.ts
git commit -m "feat: gate member applications on member-applications flag"
```

---

## Task 8: Gate velocity spam (TTL-cached, hot path)

`features/spam/service.ts:215` runs `analyzeVelocity` on **every message**. An uncached PostHog network check per message is unacceptable, so wrap the check in a small per-guild TTL cache. Extract the gated logic into its own module so it is unit-testable in isolation.

**Files:**
- Create: `app/features/spam/velocityGate.ts`
- Create: `app/features/spam/velocityGate.test.ts`
- Modify: `app/features/spam/service.ts:214-243`
- Modify: `app/AppRuntime.ts` (provide `FeatureFlagService` to the spam layer)

- [ ] **Step 1: Write the failing test**

Create `app/features/spam/velocityGate.test.ts`. It exercises the cache + gate against a mock `FeatureFlagService`. (Mirror the mock style in `featureFlags.test.ts`.)

```ts
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { IFeatureFlagService } from "#~/effects/featureFlags";

import { analyzeVelocity } from "./velocityAnalyzer";
import { clearVelocityFlagCache, gatedVelocitySignals } from "./velocityGate";

const makeFlags = (enabled: boolean, calls = { n: 0 }): IFeatureFlagService =>
  ({
    isPostHogEnabled: () => {
      calls.n += 1;
      return Effect.succeed(enabled);
    },
    getPostHogValue: () => Effect.die("unused"),
    isTierEnabled: () => Effect.succeed(false),
    requireTierFeature: () => Effect.void,
  }) as unknown as IFeatureFlagService;

const NOW = 1_000_000;
const messages = [
  { messageId: "1", channelId: "c", contentHash: "h", timestamp: NOW, hasLink: false },
  { messageId: "2", channelId: "c", contentHash: "h", timestamp: NOW, hasLink: false },
];

afterEach(() => clearVelocityFlagCache());

describe("gatedVelocitySignals", () => {
  test("returns analyzeVelocity output when the flag is enabled", async () => {
    const flags = makeFlags(true);
    const result = await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW }),
    );
    expect(result).toEqual(analyzeVelocity(messages, "h"));
  });

  test("returns [] when the flag is disabled", async () => {
    const flags = makeFlags(false);
    const result = await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW }),
    );
    expect(result).toEqual([]);
  });

  test("caches the flag value within the TTL (one lookup)", async () => {
    const calls = { n: 0 };
    const flags = makeFlags(true, calls);
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW, ttlMs: 60_000 }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW + 30_000, ttlMs: 60_000 }),
    );
    expect(calls.n).toBe(1);
  });

  test("re-checks after the TTL expires", async () => {
    const calls = { n: 0 };
    const flags = makeFlags(true, calls);
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW, ttlMs: 60_000 }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW + 61_000, ttlMs: 60_000 }),
    );
    expect(calls.n).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run app/features/spam/velocityGate.test.ts`
Expected: FAIL — `velocityGate.ts` does not exist.

- [ ] **Step 3: Implement `app/features/spam/velocityGate.ts`**

```ts
import { Effect } from "effect";

import { FeatureFlagService, type IFeatureFlagService } from "#~/effects/featureFlags";

import { analyzeVelocity } from "./velocityAnalyzer";

const DEFAULT_TTL_MS = 60_000;

// Per-guild cache of the velocity-spam flag value. Bounds the per-message cost
// to a Map lookup; the network flag check happens at most once per TTL window.
const cache = new Map<string, { value: boolean; expiresAt: number }>();

/** Test-only: reset the module cache between cases. */
export const clearVelocityFlagCache = () => cache.clear();

interface GateOpts {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Returns velocity spam signals only when the `velocity-spam` flag is enabled
 * for the guild, caching the flag value per guild for `ttlMs`.
 */
export const gatedVelocitySignals = (
  flags: IFeatureFlagService,
  guildId: string,
  recentMessages: Parameters<typeof analyzeVelocity>[0],
  contentHash: string,
  opts: GateOpts = {},
) =>
  Effect.gen(function* () {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const now = (opts.now ?? Date.now)();

    const cached = cache.get(guildId);
    let enabled: boolean;
    if (cached && cached.expiresAt > now) {
      enabled = cached.value;
    } else {
      enabled = yield* flags.isPostHogEnabled("velocity-spam", guildId);
      cache.set(guildId, { value: enabled, expiresAt: now + ttlMs });
    }

    return enabled ? analyzeVelocity(recentMessages, contentHash) : [];
  });

// Re-export the Tag so callers in Effect context can resolve the service.
export { FeatureFlagService };
```

> Check `analyzeVelocity`'s exact parameter types in `velocityAnalyzer.ts` and
> match them; `Parameters<typeof analyzeVelocity>[0]` keeps the gate in sync.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run app/features/spam/velocityGate.test.ts` → all PASS.

- [ ] **Step 5: Use the gate in `service.ts`**

In `app/features/spam/service.ts`, replace line 215 (`const velocitySignals = analyzeVelocity(recentMessages, contentHash);`) with:

```ts
          const flags = yield* FeatureFlagService;
          const velocitySignals = yield* gatedVelocitySignals(
            flags,
            guildId,
            recentMessages,
            contentHash,
          );
```

Update the imports near the top of `service.ts`:
- It already imports `analyzeVelocity, getPriorDuplicates` from `./velocityAnalyzer.ts` (line 34) — keep `getPriorDuplicates`; `analyzeVelocity` may now be unused here (it moved into the gate). Remove it from this import if lint flags it.
- Add: `import { FeatureFlagService, gatedVelocitySignals } from "./velocityGate";`

The downstream `hasDuplicateSignal`/`priorDuplicates` logic (lines 229-243) is unchanged — when the flag is off, `velocitySignals` is `[]`, so `hasDuplicateSignal` is `false` and the block is skipped naturally.

- [ ] **Step 6: Provide `FeatureFlagService` to the spam layer**

`service.ts`'s `checkMessage` effect now requires `FeatureFlagService`. The spam layer is currently provided only `DatabaseLayer` (`AppRuntime.ts:33`). Update it:

```ts
import { FeatureFlagServiceLive } from "#~/effects/featureFlags";
```

and change line 33:

```ts
  Layer.provide(
    SpamDetectionServiceLive,
    Layer.merge(DatabaseLayer, FeatureFlagServiceLive),
  ),
```

`FeatureFlagServiceLive` is already self-contained (it provides its own `DatabaseLayer` + `PostHogServiceLive`), so this resolves the new requirement. `FeatureFlagServiceLive` is exported from `featureFlags.ts`.

> If `SpamDetectionServiceLive` is also constructed/used in tests with a
> hand-built layer, update those to provide `FeatureFlagServiceLive` (or a mock)
> too. Search: `rg "SpamDetectionServiceLive" app`.

- [ ] **Step 7: Typecheck + run spam tests**

Run: `npm run typecheck && npx vitest run app/features/spam/`
Expected: typecheck passes; spam tests (including the existing `velocityAnalyzer.test.ts`) pass.

- [ ] **Step 8: Lint + commit**

```bash
npm run lint
git add app/features/spam/velocityGate.ts app/features/spam/velocityGate.test.ts app/features/spam/service.ts app/AppRuntime.ts
git commit -m "feat: gate velocity spam detection on velocity-spam flag (TTL-cached)"
```

---

## Task 9: Remove the dead DB-entitlement code

With every paid feature now gated by a PostHog flag, the DB-direct entitlement paths have no production callers. Remove them.

**Files:**
- Modify: `app/effects/featureFlags.ts`
- Modify: `app/effects/featureFlags.test.ts`
- Modify: `app/models/subscriptions.server.ts`

- [ ] **Step 1: Remove `hasFeature` from `subscriptions.server.ts`**

Delete the entire `async hasFeature(...)` method (lines 242-277, including its inline `PAID_FEATURES` set). Verify no remaining callers:

Run: `rg "hasFeature" app` → expect zero results (Task 5 removed the only caller).

- [ ] **Step 2: Remove the `TierFlag` machinery from `featureFlags.ts`**

Delete:
- the `TierFlag` `Schema.Literal` + type (lines 8-12),
- the `PAID_FEATURES` set (line 24),
- the `isTierEnabled` and `requireTierFeature` members from `IFeatureFlagService` (lines 40-50),
- the `checkTier` closure and the `isTierEnabled` / `requireTierFeature` implementations in `FeatureFlagServiceLive` (lines 64-91, 130-149).

Keep `isPostHogEnabled`, `getPostHogValue`, `withFeatureFlag`, `guardFeature`, and the `FeatureDisabledError` import (still used by `guardFeature`). The resulting `IFeatureFlagService` has just `isPostHogEnabled` and `getPostHogValue`.

- [ ] **Step 3: Update the test mock**

In `app/effects/featureFlags.test.ts`, remove `isTierEnabled` and `requireTierFeature` from the `makeMockFlags` object (lines 60-61) so the mock matches the trimmed interface. Do the same in `velocityGate.test.ts`'s `makeFlags` (drop those two members). The mocks now only need `isPostHogEnabled` + `getPostHogValue`.

- [ ] **Step 4: Find and fix any other references**

Run: `rg "TierFlag|requireTierFeature|isTierEnabled|PAID_FEATURES" app`
Expected: zero results after edits. Fix any stragglers.

- [ ] **Step 5: Typecheck + tests + lint**

Run: `npm run typecheck && npx vitest run app/effects/ app/features/spam/ && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/effects/featureFlags.ts app/effects/featureFlags.test.ts app/features/spam/velocityGate.test.ts app/models/subscriptions.server.ts
git commit -m "refactor: remove dead DB-backed TierFlag/hasFeature entitlement code"
```

---

## Task 10: Full validation + manual verification

- [ ] **Step 1: Full validation suite**

Run: `npm run validate` (test + lint + typecheck). Expected: all pass.

- [ ] **Step 2: Manual verification checklist** (record results in the PR description)

- A **free** guild (no subscription, not comped, not the allowlisted dev guild): ticket button → "isn't enabled"; apply button → "isn't enabled"; velocity spam signals do not fire; `/export-data?guild_id=...` → 403.
- A **paid** guild (`subscription_tier=paid`, `subscription_status=active` on its PostHog group): all four features work; escalation still works.
- A **comped** guild (`comped` group property set): all four features work without a paid subscription.
- After simulating a subscription write (call a webhook handler or `payment.success` path), confirm `syncGuildGroup` ran and the guild's PostHog group shows the new `subscription_tier` — without a bot restart.

- [ ] **Step 3: Open the PR (only with owner's go-ahead)**

Merge-commit PR into `main`. Title: "Per-feature PostHog flag gating for paid features". Body: link the spec, list the behavior change (free guilds lose ticketing/velocity/applications/export), and paste the manual verification results.

---

## Self-review notes (author)

- **Spec coverage:** flags (T1), union (T2), enforcement for all five features (escalate already done; ticketing T6, applications T7, velocity T8, export T5), sync fix (T3), dead-code removal (T9). All spec sections map to a task.
- **Type consistency:** `gatedVelocitySignals`, `clearVelocityFlagCache`, `isFeatureEnabled`, `syncGuildGroup` names are used identically across tasks. `IFeatureFlagService` is trimmed in T9 and the mocks updated in the same task.
- **Known soft spots to verify during execution (called out inline):** exact field names on `SubscriptionService.getGuildSubscription` (T3); `analyzeVelocity` parameter type (T8); whether `payment.success.tsx` should use static vs dynamic import (T3); any test-side construction of `SpamDetectionServiceLive` (T8); residual `SubscriptionService` import in `export-data.tsx` (T5).
