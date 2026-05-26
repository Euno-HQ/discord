# Per-feature PostHog flag gating for paid features

**Date:** 2026-05-26
**Status:** Design — approved; implementation plan in `2026-05-26_2_per-feature-flag-gating-plan.md`
**Branch:** `feature/per-feature-flag-gating` (off `main`)

## Problem

The paid tier is gated by a single DB-backed `premium_moderation` entitlement
that, in practice, gates almost nothing. Current reality:

| Paid feature | PostHog flag | Flag conditions correct? | Enforced in code? |
|---|---|---|---|
| Escalation voting | `escalate` | ✅ paid+active / comped / allowlist | ✅ `escalate.ts:52` (`guardFeature`) |
| Shared ticketing | `ticketing` | ✅ same | ❌ **flag is never read** |
| Velocity/raid spam | — none — | — | ❌ runs for every guild (`features/spam/service.ts:215`) |
| Member applications | — none — | — | ❌ runs for every guild (`commands/memberApplications.ts`) |
| Data export | — none — | — | DB check `hasFeature("data_export")` (`routes/export-data.tsx:27`) |

So today **only escalation is actually paid.** Ticketing has a correct flag
nothing reads; velocity spam + applications run for everyone.

Two parallel, redundant DB-backed gating mechanisms exist, both mostly dead:

- `featureFlags.ts` → `TierFlag` (`advanced_analytics`, `premium_moderation`),
  `checkTier`, `isTierEnabled`, `requireTierFeature`, `PAID_FEATURES`.
  **Zero production callers** (tests only).
- `subscriptions.server.ts` → `hasFeature()` + its own inline `PAID_FEATURES`
  set. One caller: `export-data.tsx`.

## Goal

PostHog owns paid-feature gating. The DB remains the billing record of truth but
is only *projected* onto the `guild` PostHog group as `subscription_tier` /
`subscription_status` properties; per-feature PostHog flags make the actual
gating decision. Retire the DB-direct entitlement paths.

## Architecture (the model that already works)

`escalate` and `ticketing` are the template. Each flag has three OR'd release
conditions on the `guild` group (`aggregation_group_type_index: 0`):

1. `subscription_tier = paid` **AND** `subscription_status = active` — the paid gate
2. `comped is_set` — manual free-grant escape hatch
3. `id = 822583790773862470` — dev/owner guild escape hatch

`posthog.ts:44` (`initializeGroups`) already writes `subscription_tier` /
`subscription_status` onto the guild group from the DB subscription. Server-side
flag evaluation (`featureFlags.ts:97`) reads those stored group properties.
Flag-not-found and errors return `false` — fail-closed, correct for a paywall.

**Data flow:** Stripe webhook → DB `guild_subscriptions.product_tier` →
`groupIdentify` updates PostHog guild group property → PostHog flag evaluates
`subscription_tier=paid` at request time → feature runs or is denied.

## Changes (summary — see the plan for exact steps)

1. **Create three PostHog flags** — `velocity-spam`, `member-applications`,
   `data-export` — each cloning the `escalate`/`ticketing` 3-condition filter.
2. **`BooleanFlag` union** (`featureFlags.ts:14`): add the three keys.
3. **Wire enforcement** so flags actually gate:
   - Velocity spam — `features/spam/service.ts:215`, behind a **TTL-cached** flag
     check (this path runs on every message; an uncached network check per
     message is not acceptable).
   - Ticketing — `open-ticket` button handler in `commands/setupTickets.ts:156`.
   - Member applications — `apply-to-join` button handler in
     `commands/memberApplications.ts:104`.
   - Data export — `routes/export-data.tsx:27`, via a new `AppRuntime`
     `isFeatureEnabled` helper.
   - Escalation already wired.
4. **Fix subscription→PostHog sync:** extract `syncGuildGroup(guildId)` from
   `initializeGroups` and call it after every subscription write in
   `webhooks.stripe.tsx` (3 handlers) + `payment.success.tsx`. Without this,
   upgrades/downgrades don't change flag evaluation until the next bot restart.
5. **Delete dead DB-entitlement code:** `TierFlag`/`checkTier`/
   `requireTierFeature`/`isTierEnabled`/`PAID_FEATURES` in `featureFlags.ts`;
   `hasFeature()` + inline `PAID_FEATURES` in `subscriptions.server.ts` (after
   export migrates off it). Update `featureFlags.test.ts`.

## Edge cases / risks

- **Fail-closed:** PostHog unavailable / flag missing → `false`. A paying customer
  could lose access during a PostHog outage. Accepted; matches `escalate` today.
  `comped` + allowlist remain manual overrides.
- **Ordering for safety:** create the flags (with paid conditions) **before**
  shipping enforcement, so paid guilds never lose access. Enforcement code with a
  missing flag would deny everyone.
- **Hot-path cost:** velocity runs per message; gate it behind a 60s per-guild
  TTL cache, not a per-message network call. Bounds paywall staleness on that
  path to 60s — fine for a paywall.
- **Sync timing:** `groupIdentify` is eventually consistent on PostHog's side; a
  freshly-upgraded guild may see a short delay before flags flip. Acceptable.
- **Behavior change on deploy:** free guilds currently using ticketing /
  velocity / applications / export lose them unless paid/comped/allowlisted. This
  is the intended correction — flag it before shipping.

## Out of scope

- `analytics` flag gates on an allowlist of two guild IDs, **not**
  `subscription_tier`. Inconsistent, but analytics isn't a `premium_moderation`
  feature and wasn't requested. Follow-up.
- `extended_history`, `unlimited_message_tracking`, `priority_support`,
  `custom_integrations` — other `PAID_FEATURES` keys, not addressed here.
- No changes to Stripe products, pricing, or the `guild_subscriptions` schema.
