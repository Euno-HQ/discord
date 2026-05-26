# Back-merge `release` → `main` — Design

**Date:** 2026-05-25
**Status:** Approved design, pending implementation plan
**Branch:** `feat-backmerge-release-to-main`

## Problem

RC branches are cut from `main` (`git checkout -b rc/vYYYY.WW origin/main` in
`release-candidate.yml`). During UAT testing, bug fixes are pushed *directly* to
the `rc/*` branch, then the RC PR merges into `release`. Those fix commits — and
the `release` branch's merge commits — never return to `main`. Over time `release`
diverges from `main`: fixes that shipped to production silently go missing from the
development line. There is no workflow and no documented process to reconcile this
(only a TODO in `notes/2025-12-14_1_ci-cd-architecture-review.md`).

## Goals

- Automatically reconcile `release` back into `main` after each production release.
- A bad merge must never silently break `main` — CI gates the landing.
- No human action required for the common (clean) case.
- Don't duplicate CI logic; `ci.yml` is the single source of truth.
- Honor existing conventions: merge commits (not squash), no unattended direct
  pushes to `main` for un-gated content.

## Non-goals

- Changing how RC branches are cut or how fixes are applied during UAT.
- Cherry-pick-based reconciliation (see "Why merge, not cherry-pick").
- Back-merging drafts that were never published.

## Locked decisions

1. **Trigger: on `release: published`.** Back-merge fires from the same event that
   deploys production (`promote-release.yml`'s `deploy-production`). `main` receives
   release-only fixes exactly when they actually ship — "what's in prod is in main."
   An abandoned/never-published draft is never back-merged.

2. **Oversight: auto-merge when clean, via a gated PR.** The back-merge always opens
   a `release → main` PR and enables GitHub auto-merge. A clean, CI-green PR merges
   itself with zero human action; a PR with conflicts or red CI stays open for a
   human. CI is a true **pre-merge gate**, not after-the-fact detection.

### Why merge, not cherry-pick

A true merge records ancestry, so once `release` is merged its commits are never
re-proposed. Cherry-picking rewrites SHAs, causing the *same* conflicts to resurface
on every subsequent back-merge. Merge is the resilient steady-state mechanism;
cherry-pick stays useful only for one-off emergency hotfixes.

## Design

### 1. `ci.yml` — single CI source of truth

Today `ci.yml` triggers on `push: { branches-ignore: [main] }`. Change to:

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

- `pull_request` runs CI against the **merge ref** (head merged into base), so it
  validates exactly what would land on `main`. This is what gates the back-merge PR,
  and it tightens every other PR as a side benefit.
- `push: [main]` covers the landed commit on `main`.
- **Behavior change to flag:** non-PR branch pushes will no longer auto-run CI
  (today every branch push runs it). The team flow is PR-based, so this is acceptable
  and removes redundant runs — but it is a real change in behavior.

Job names (`ESLint`, `TypeScript`, `Vitest`) are unchanged so they can be referenced
as required status checks.

### 2. `main` branch protection (one-time GitHub settings change)

Not code — configured in repo settings, documented here and in the implementation
plan as an explicit step:

- Mark CI jobs **`ESLint`, `TypeScript`, `Vitest`** as **required status checks** on
  `main`.
- Enable **Allow auto-merge** on the repository.

This is what makes auto-merge *wait* for green rather than merging instantly. It also
closes the pre-existing gap that `main` has no required status checks
(see `project_cicd_architecture` memory / `notes/2025-12-14_1_...`).

**Verified & corrected 2026-05-26.** The May 25 config was a repository **ruleset**
("Checks pass", id `16854963`), not classic branch protection — and it was
misconfigured: `enforcement: disabled`, targeting `~ALL` branches, and bundling a
`Restrict updates` rule that (with no bypass actors) would have blocked *all* updates
to a branch, including PR merges. Corrected via the rulesets API to:

- `enforcement: active`
- target `~DEFAULT_BRANCH` (main only)
- rules: `deletion`, `non_fast_forward`, `required_status_checks`; the `update`
  (Restrict updates) rule **removed** so PR merges/auto-merge to main still work
- required checks: `build`, `ESLint`, `TypeScript`, `Vitest`
  (team chose to keep `build` from `cd.yml` in addition to the `ci.yml` checks)
- `strict_required_status_checks_policy: false` (avoid auto-merge stalls when main advances)
- repo `allow_auto_merge` was already `true`

Caveat: `build` is produced by `cd.yml` (`on: push`), so it reports on same-repo branch
pushes; fork PRs (which don't trigger `cd.yml`) would lack `build`. This team pushes
branches directly, so not a concern in practice.

### 3. New workflow `.github/workflows/backmerge.yml`

Trigger:

```yaml
on:
  release:
    types: [published]

concurrency:
  group: backmerge-main
  cancel-in-progress: false
```

Steps (single job):

1. **Checkout** with `fetch-depth: 0` (needs full history of both branches).
2. **Idempotency guard:** if `git merge-base --is-ancestor origin/release origin/main`
   succeeds, exit cleanly — `release` is already integrated, nothing to do. After any
   successful back-merge this is true, so re-runs and no-fix cycles are safe no-ops.
   Also skip if an open `backmerge/*` PR already exists.
3. **Create branch** `backmerge/<release-tag>` at `origin/release` and push it.
4. **Open PR** `base: main`, `head: backmerge/<tag>`, labeled `backmerge`, with a body
   explaining it is an automated back-merge and how to resolve conflicts locally.
5. **Enable auto-merge:** `gh pr merge <pr> --auto --merge` (merge commit, honoring the
   merge-commit policy).
6. GitHub then takes over:
   - CI runs on the PR (via `ci.yml` `pull_request`).
   - **Clean + green → auto-merges, no human action.**
   - **Conflict or red CI → auto-merge stays pending; PR waits for a human.** Resolution:
     check out `backmerge/<tag>`, `git merge origin/main`, resolve, push — CI re-runs and
     auto-merge completes (or merge manually).

#### Critical auth detail

The branch push **and** PR creation must use the **GitHub App token**
(`APP_ID` / `APP_PRIVATE_KEY`, already used in `cd.yml` and `promote-release.yml`),
**not** the default `GITHUB_TOKEN`. Events triggered by `GITHUB_TOKEN` do **not** start
new workflow runs, so `ci.yml` would never run on the bot-created PR and the gate would
never be satisfiable. A GitHub App installation token is a distinct actor and does
trigger CI.

Required workflow permissions: `contents: write`, `pull-requests: write`.

## Resilience properties / edge cases

- **True merge commit** on `main` → already-integrated history is never re-proposed
  (no recurring-conflict trap).
- **Idempotent** — safe to re-run; safe when there are no release-only changes.
- **No silent breakage** — code lands only if conflict-free *and* CI-green; otherwise it
  becomes a visible PR.
- **Empty-diff releases** (RC merged with zero direct fixes): `release` still carries its
  own merge commit not on `main`, so a PR is opened and auto-merges (CI passes on an
  empty diff). Slightly noisy but preserves the "release is an ancestor of main"
  invariant the idempotency guard relies on. Acceptable; optimize later if noisy.
- **Race with new `main` commits during the run:** the PR's merge ref recomputes;
  auto-merge merges when mergeable. No special handling needed (PR model, not direct push).
- **Concurrency:** `backmerge-main` group prevents two releases' back-merges from racing.

## Forward dependency note

If `main` protection is later changed to *require pull requests*, no part of this design
breaks — it already uses a PR for every back-merge. (This is a deliberate improvement over
an earlier direct-push variant that would have broken under that change.)

## Files / changes

- `.github/workflows/ci.yml` — change triggers (single CI source of truth).
- `.github/workflows/backmerge.yml` — new workflow.
- Repo settings (manual, documented): required status checks on `main` + allow auto-merge.
- Optional: a `backmerge` label.

## Open questions

- None blocking. Possible future optimization: skip opening a PR when the back-merge diff
  is empty (would require an alternative way to advance the idempotency invariant).
