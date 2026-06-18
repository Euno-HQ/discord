# Back-merge `release` → `main` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically open a CI-gated, auto-merging PR that brings `release` back into `main` whenever a GitHub Release is published, so production fixes stop disappearing from the development line.

**Architecture:** Three changes. (1) `ci.yml` becomes the single CI source of truth — it runs on `pull_request` (testing the merge ref) and on `push` to `main`. (2) `main` branch protection requires the CI checks and the repo allows auto-merge — this is what makes auto-merge *wait* for green. (3) A new `backmerge.yml` workflow fires on `release: published`, and (after an idempotency guard) pushes a `backmerge/<tag>` branch at the `release` tip, opens a `release → main` PR, and enables GitHub auto-merge. GitHub then runs CI and merges automatically when clean+green, or leaves the PR for a human on conflict/failure.

**Tech Stack:** GitHub Actions, `gh` CLI (`github-script` not needed), `actions/create-github-app-token`, `actionlint` for static validation.

**Testing model (read first):** Workflow YAML has no unit-test harness, and this repo keeps workflow logic inline (see `cd.yml`, `promote-release.yml`), so we follow that pattern rather than extracting scripts. "Tests" here = `actionlint` static checks + observed live runs. `backmerge.yml` includes a `workflow_dispatch` trigger specifically so it can be run manually for verification without publishing a real release; the idempotency guard makes a manual run a safe no-op when `release` and `main` haven't diverged.

**Prerequisite:** Tooling check — install `actionlint` once. Run: `brew install actionlint` (expected: installs, or "already installed"). Fallback YAML validity check if brew is unavailable: `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1])); print('ok')" <file>`.

---

### Task 1: Make `ci.yml` the single CI source of truth

**Files:**
- Modify: `.github/workflows/ci.yml` (the `on:` block only)

- [ ] **Step 1: Change the trigger block**

Replace exactly this block:

```yaml
on:
  push:
    branches-ignore:
      - "main"
```

with:

```yaml
on:
  pull_request:
  push:
    branches:
      - main
```

Leave everything else (`name`, `concurrency`, `env: HUSKY: 0`, and all three jobs `ESLint` / `TypeScript` / `Vitest`) unchanged. The job `name:` values must stay `ESLint`, `TypeScript`, `Vitest` — they are referenced as required status checks in Task 2.

- [ ] **Step 2: Validate the workflow statically**

Run: `actionlint .github/workflows/ci.yml`
Expected: no output, exit code 0. (Fallback: the `python3 ... yaml.safe_load` one-liner prints `ok`.)

- [ ] **Step 3: Confirm intent in the diff**

Run: `git diff .github/workflows/ci.yml`
Expected: only the `on:` block changed — `pull_request:` added, `push` now scoped to `main`. No job changes.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run CI on pull_request and main

Run CI against the PR merge ref (validates exactly what lands) and on pushes
to main, instead of every non-main branch push. Makes ci.yml the single CI
source of truth so the back-merge PR is gated by the same checks. Non-PR
branch pushes no longer auto-run CI; the team flow is PR-based."
```

---

### Task 2: Verify (and fix if needed) `main` branch protection + auto-merge

This step was applied manually on 2026-05-25 but not verified (per the design doc). The back-merge gate does not work unless BOTH are true: the CI jobs are required status checks on `main`, AND the repo allows auto-merge. If required checks are missing, `gh pr merge --auto` either errors or merges immediately with no gate.

**Files:**
- Modify (record only): `notes/2026-05-25_1_backmerge-release-to-main-design.md` (append a verification result line)

- [ ] **Step 1: Check required status checks on `main`**

Run:
```bash
gh api repos/Euno-HQ/discord/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts}'
```
Expected: `contexts` contains `"ESLint"`, `"TypeScript"`, and `"Vitest"`. Recommended `strict: false` (see Step 3). If the call 404s or `required_status_checks` is null, the checks are NOT configured → go to Step 3.

- [ ] **Step 2: Check the repo allows auto-merge**

Run: `gh api repos/Euno-HQ/discord --jq '.allow_auto_merge'`
Expected: `true`. If `false`, run: `gh api -X PATCH repos/Euno-HQ/discord -f allow_auto_merge=true` and re-check.

- [ ] **Step 3: Apply required checks only if Step 1 showed them missing/incorrect**

Skip if Step 1 already passed. Otherwise run:
```bash
gh api -X PATCH repos/Euno-HQ/discord/branches/main/protection/required_status_checks \
  -f strict=false \
  -f 'contexts[]=ESLint' -f 'contexts[]=TypeScript' -f 'contexts[]=Vitest'
```
`strict=false` is deliberate: with `strict=true`, every new commit on `main` would force the back-merge branch to update before auto-merge could complete, causing churn. Re-run Step 1 to confirm.

- [ ] **Step 4: Record the verified result and commit**

Edit the design doc line that currently reads:
`As of May 25th, this step has been performed, but has not been verified as correctly configured.`
to:
`Verified 2026-05-26: required checks ESLint/TypeScript/Vitest present on main (strict=false); allow_auto_merge=true.`
(Adjust the text to match what you actually observed.)

```bash
git add notes/2026-05-25_1_backmerge-release-to-main-design.md
git commit -m "docs: record verified main branch-protection config for back-merge gate"
```

---

### Task 3: Add the `backmerge.yml` workflow

**Files:**
- Create: `.github/workflows/backmerge.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/backmerge.yml` with exactly this content:

```yaml
name: Back-merge release into main

on:
  release:
    types: [published]
  workflow_dispatch:

concurrency:
  group: backmerge-main
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  backmerge:
    runs-on: ubuntu-latest
    steps:
      - name: Generate GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          owner: Euno-HQ

      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ steps.app-token.outputs.token }}

      - name: Determine back-merge ref
        id: ref
        env:
          RELEASE_TAG: ${{ github.event.release.tag_name }}
        run: |
          if [ -n "${RELEASE_TAG}" ]; then
            REF="${RELEASE_TAG}"
          else
            REF="manual-$(date -u +%Y%m%d%H%M%S)"
          fi
          echo "ref=${REF}" >> "$GITHUB_OUTPUT"
          echo "branch=backmerge/${REF}" >> "$GITHUB_OUTPUT"

      - name: Check whether release is already merged into main
        id: guard
        run: |
          git fetch origin main release
          if git merge-base --is-ancestor origin/release origin/main; then
            echo "merged=true" >> "$GITHUB_OUTPUT"
            echo "release is already an ancestor of main; nothing to back-merge."
          else
            echo "merged=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Check for an existing open back-merge PR
        id: existing
        if: steps.guard.outputs.merged == 'false'
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          EXISTING=$(gh pr list --base main --state open \
            --json number,headRefName \
            --jq 'map(select(.headRefName | startswith("backmerge/"))) | .[0].number // empty')
          if [ -n "$EXISTING" ]; then
            echo "number=${EXISTING}" >> "$GITHUB_OUTPUT"
            echo "An open back-merge PR already exists: #${EXISTING}; skipping."
          fi

      - name: Create back-merge branch at release tip
        if: steps.guard.outputs.merged == 'false' && steps.existing.outputs.number == ''
        env:
          BRANCH: ${{ steps.ref.outputs.branch }}
        run: |
          git push --force origin "origin/release:refs/heads/${BRANCH}"

      - name: Open back-merge PR and enable auto-merge
        if: steps.guard.outputs.merged == 'false' && steps.existing.outputs.number == ''
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          BRANCH: ${{ steps.ref.outputs.branch }}
          REF: ${{ steps.ref.outputs.ref }}
        run: |
          cat > /tmp/backmerge-body.md <<EOF
          Automated back-merge of release into main after publishing ${REF}.

          Brings release-only fixes (pushed to rc/* during UAT) back into the development line.

          * Clean + CI-green: this PR auto-merges with no action needed.
          * Conflicts or red CI: auto-merge stays pending. To resolve, run:

              git fetch origin
              git checkout ${BRANCH}
              git merge origin/main
              # resolve conflicts, commit, and push
          EOF

          gh label create backmerge --color BFD4F2 \
            --description "Automated back-merge of release into main" 2>/dev/null || true

          PR_URL=$(gh pr create \
            --base main \
            --head "${BRANCH}" \
            --title "Back-merge release ${REF} into main" \
            --label backmerge \
            --body-file /tmp/backmerge-body.md)
          echo "Opened ${PR_URL}"

          gh pr merge "${PR_URL}" --auto --merge
```

Notes baked into this file:
- App token (not `GITHUB_TOKEN`) is used for checkout push and all `gh` calls, so the PR-open event triggers `ci.yml` (events from `GITHUB_TOKEN` don't start new workflow runs).
- The PR body uses 4-space indentation for the command block (no backticks) to avoid heredoc command-substitution issues while still expanding `${REF}`/`${BRANCH}`.
- `git push --force` only runs when no open back-merge PR exists, so it cannot disrupt a PR under review; it just refreshes a stale branch.

- [ ] **Step 2: Validate statically**

Run: `actionlint .github/workflows/backmerge.yml`
Expected: no output, exit 0. (Fallback: `python3 ... yaml.safe_load` prints `ok`.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/backmerge.yml
git commit -m "feat: add back-merge release->main workflow

On release publish (or manual dispatch), open a CI-gated release->main PR and
enable GitHub auto-merge: clean+green auto-merges, conflicts/failures wait for
a human. Idempotency guard (release already ancestor of main) and existing-PR
check make it safe to re-run."
```

---

### Task 4: Live end-to-end verification

This validates the two behaviors that static linting can't: that `ci.yml` now runs on PRs, and that `backmerge.yml` runs and opens (or correctly no-ops) a back-merge PR. It requires pushing the branch and using `workflow_dispatch`.

**Files:** none (verification only)

- [ ] **Step 1: Push the branch and open the feature PR**

```bash
git push -u origin feat-backmerge-release-to-main
gh pr create --base main --head feat-backmerge-release-to-main \
  --title "Back-merge release into main (CI gate + workflow)" \
  --body "Implements notes/2026-05-25_1 design: ci.yml single-source triggers, backmerge.yml, verified branch protection."
```
Expected: PR created.

- [ ] **Step 2: Confirm `ci.yml` runs on this PR via `pull_request`**

Run: `gh pr checks feat-backmerge-release-to-main --watch`
Expected: checks named `ESLint`, `TypeScript`, `Vitest` appear and complete. This proves Task 1's `pull_request` trigger works and that these are the contexts to require (Task 2).

- [ ] **Step 3: Dispatch the back-merge workflow against this branch**

Run:
```bash
gh workflow run "Back-merge release into main" --ref feat-backmerge-release-to-main
sleep 5
gh run list --workflow=backmerge.yml --limit 1
```
Then watch the latest run: `gh run watch $(gh run list --workflow=backmerge.yml --limit 1 --json databaseId --jq '.[0].databaseId')`

Expected — one of:
- If `release` is already an ancestor of `main`: the `guard` step logs "release is already an ancestor of main; nothing to back-merge." and later steps are skipped. Safe no-op confirming the guard. ✅
- If `release` has diverged: a real `backmerge/manual-<timestamp>` branch + PR are created and auto-merge is enabled. Inspect with `gh pr list --label backmerge`. This is the genuine feature working. ✅

- [ ] **Step 4: If Step 3 created a back-merge PR, confirm gating**

Run: `gh pr view <backmerge-pr-number> --json autoMergeRequest,mergeStateStatus`
Expected: `autoMergeRequest` is non-null (auto-merge enabled). The PR merges itself once CI is green and it's conflict-free; if `mergeStateStatus` indicates conflicts, it waits — confirming the human-fallback path.

- [ ] **Step 5: Record outcome**

Note in the feature PR (a comment) which branch of Step 3 occurred (no-op vs. real PR) and that CI ran via `pull_request`. No commit needed.

---

## Self-Review

**Spec coverage:**
- Design §1 (ci.yml single source) → Task 1. ✅
- Design §2 (branch protection required checks + allow auto-merge) → Task 2 (verify/fix). ✅
- Design §3 (backmerge.yml: trigger, idempotency guard, existing-PR check, branch from release, PR, auto-merge, App-token auth, permissions, concurrency) → Task 3. ✅
- Design "Resilience/edge cases" (idempotent re-run, empty-diff, race, concurrency) → covered by the guard + existing-PR check + `concurrency` group in Task 3; live-checked in Task 4. ✅
- Design "Critical auth detail" (App token so CI fires) → Task 3 file + note, proven in Task 4 Step 2. ✅

**Placeholder scan:** `<release-tag>`/`<tag>`/`<backmerge-pr-number>` appear only as runtime values shown in command examples, not as unfilled plan content. All workflow code is complete. No TBD/TODO. ✅

**Type/name consistency:** Job/context names `ESLint`/`TypeScript`/`Vitest` are identical across Task 1 (unchanged jobs), Task 2 (required contexts), and Task 4 (observed checks). Step outputs (`ref.outputs.branch`, `guard.outputs.merged`, `existing.outputs.number`) are referenced consistently with how they're written. ✅

**Open item:** Empty-diff releases still open a self-merging PR (noisy but correct, per design); intentionally not optimized.
