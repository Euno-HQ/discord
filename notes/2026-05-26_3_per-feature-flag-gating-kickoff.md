# Kickoff: Per-feature PostHog flag gating

**You are picking up a ready-to-implement project.** Read this, then the spec,
then the plan, then execute.

## TL;DR

Make Euno's four paid `premium_moderation` features (escalation, ticketing,
velocity spam, member applications) **plus** data export each gate on its own
PostHog feature flag, and delete the dead DB-backed entitlement code. The design
and a complete, bite-sized TDD plan already exist. Your job is to execute the
plan.

## Where you are

- **Worktree:** `/Users/vcarl/workspace/mod-bot/.claude/worktrees/flag-gating`
- **Branch:** `feature/per-feature-flag-gating` (off `main`, currently clean)
- **Run everything from this worktree.** Do not `cd` to the main repo.

## Read these, in order

1. `notes/2026-05-26_1_per-feature-flag-gating.md` — the design/spec (the "why").
2. `notes/2026-05-26_2_per-feature-flag-gating-plan.md` — the implementation plan
   (the "how"), 10 tasks with exact code and commands.
3. `notes/EFFECT.md` — **required** before touching any Effect-TS code (this
   project uses Effect heavily; the gates are written in it).

## The one insight you need that the code hides

Two separate gating mechanisms exist in this codebase, and they're easy to
conflate:

- **PostHog boolean flags** (`featureFlags.ts` → `BooleanFlag`, checked via
  `isPostHogEnabled`). These evaluate against the `guild` PostHog group's
  `subscription_tier`/`subscription_status` properties, which `posthog.ts`
  projects from the DB. **This is the mechanism we're standardizing on.**
- **DB-direct tier entitlement** (`featureFlags.ts` → `TierFlag`/`checkTier`/
  `requireTierFeature`, and `subscriptions.server.ts` → `hasFeature`). These read
  `guild_subscriptions.product_tier` directly. **This is dead/legacy — we delete
  it.**

Today only **escalation** is actually gated in code. `ticketing` has a correct
flag that nothing reads; velocity spam, member applications, and (via the DB
path) data export are effectively ungated or on the legacy path. The plan fixes
all of that.

## Prerequisites before you start

- **PostHog MCP must be connected** — Task 1 creates three flags via the PostHog
  MCP (`mcp__plugin_posthog__exec`, project "Default project" id 238537, org
  "Vitullo Consulting"). If it isn't connected, ask the user to connect it (or to
  create the three flags manually from the JSON in Task 1) before proceeding.
  Discover tools with `search`, always `info <tool>` before `call <tool>`.
- Node deps installed (`npm install` if `node_modules` is missing).

## Hard constraints

- **Ordering:** Do **Task 1 (create the flags) first.** A flag that doesn't
  exist evaluates to `false` → the feature would be denied to *every* guild,
  including paying ones, the moment enforcement code runs. Flags-before-code is
  not optional.
- **Don't push or open a PR without the owner's explicit go-ahead.** Commit
  freely on this branch; pushing and PR creation are gated. PRs to `main` use
  **merge commits** (not squash).
- **Founding-engineer mindset:** these are billing-adjacent gates. A wrong edit
  either leaks paid features for free or locks out paying customers. Verify the
  "soft spots" the plan calls out inline rather than assuming.
- This is a **behavior change**: on deploy, free guilds currently using
  ticketing/velocity/applications/export will lose them unless paid, comped, or
  the allowlisted dev guild. That's intended — make sure the PR says so.

## How to execute

Use **superpowers:subagent-driven-development** (recommended — fresh subagent per
task, review between tasks) or **superpowers:executing-plans** (inline, batched
with checkpoints). The plan's tasks are already sized for either.

Each task ends in a commit. After Task 10, run `npm run validate` (test + lint +
typecheck) and walk the manual verification checklist before requesting a push.

## Quick command reference

- One test file: `npx vitest run <path>`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- All: `npm run validate`

## Out of scope (don't scope-creep)

The `analytics` flag's allowlist-only conditions, `extended_history`,
`unlimited_message_tracking`, `priority_support`, `custom_integrations`, and any
Stripe/pricing/schema changes are explicitly **not** part of this work. Note them
as follow-ups if you trip over them; don't fix them here.
