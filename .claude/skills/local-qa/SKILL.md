---
name: local-qa
description:
  Use when QA-testing mod-bot during active local development against a dev bot
  you start and drive yourself — typically a feature branch in a git worktree,
  before there's an RC. Covers standing up the dev environment, deciding per
  finding whether to fix-now/log/defer, and authoring or re-validating
  checklists. For release/RC verification against a deployed pod, use qa-session
  instead.
---

# Local QA — verification during active development

Same engine as `qa-session`, different job. `qa-session` verifies a release
candidate and reports findings to a PR without touching code. `local-qa` runs
while you're still _building_: the environment isn't ready yet, hot-reload can't
be trusted, and when you find a bug you usually want to **fix it and re-test
live**, not just file it.

This skill closes the four gaps `qa-session` leaves for dev work. It does
**not** restate the engine — read these `qa-session` sections and apply them
as-is:

- **The split of labor** — you do everything mechanical (logs, DB, tests); the
  human does only Discord-client actions.
- **Proof strength** — read the actual log line / DB row. A green Discord reply
  proves nothing. (Local SQLite is the strongest proof you have.)
- **How you communicate** — conclusions, not mechanics; resolve before asking.
- **Run log** — `.claude/qa-runs/<YYYY-MM-DD>_local.md`, gitignored, your resume
  state across `/clear`.

The payoff for doing this live: in the 2026-06-20 run, reading the actual error
annotation caught a classifier that mistagged **every** real Discord error as
`TransientError` (ESM/CJS dual-instance broke an `instanceof`) — a bug **456
passing unit tests missed**, because the mocks constructed objects the real
throw path never produces.

## Checklists

Shared with `qa-session` — they live at
`.claude/skills/qa-session/checklists/*.md` (`error-handling`, `spam`,
`automod`, `commands`, `logging`, `event-bus`, `purge`, `flags-and-web`). Read
them as your reference; the format is in `qa-session`. `local-qa` reads and
**updates** them (see Capability 4); `qa-session` only reads.

---

## Capability 1 — Stand up a working environment (the biggest gap)

**The worktree `.env` is a symlink to the root `.env`** — tokens (Discord,
PostHog) are already present. Don't copy or recreate it.

**Trap 1 — the relative DB path.** `.env` has `DATABASE_URL=./mod-bot.sqlite3`
(relative). Run the bot from a worktree and that resolves to a _fresh empty DB
in the worktree_ — no configured guild, so escalate / gate / report features
have nothing to act on. Fix: copy the dev DB into the worktree (it's gitignored;
this leaves the canonical dev DB untouched):

```bash
cp /Users/vcarl/workspace/mod-bot/mod-bot.sqlite3 ./        # plus the WAL sidecars:
cp /Users/vcarl/workspace/mod-bot/mod-bot.sqlite3-wal ./ 2>/dev/null
cp /Users/vcarl/workspace/mod-bot/mod-bot.sqlite3-shm ./ 2>/dev/null
```

Real test guild in that copy: **Test server, guildId `614601782152265748`**.

**Trap 2 — `npm run dev` reseeds.** `dev` runs `dev:init; dev:bot`, and
`dev:init` runs `kysely:seed`, which can overwrite the guild data you just
copied in. Start the bot **directly with `dev:bot`** (skip `dev:init`):

```bash
ps aux | grep '[i]ndex.dev.js'    # FIRST: no second bot on the same token/DB
node --enable-source-maps --trace-warnings index.dev.js > .claude/qa-runs/dev-bot.log 2>&1 &
```

Confirm the server is up by grepping the log for the ready line, and verify the
pid (a backgrounded `node … &` inside a wrapper can be reparented):

```bash
grep '"message":"Discord application ready"' .claude/qa-runs/dev-bot.log
```

**Hot-reload is partial** The watcher only reloads files matching these
prefixes:

```
app/server.ts   app/discord/   app/commands/   app/helpers/   app/models/
```

**`app/effects/` and everything else are NOT watched.** Edits to the error
system, classifier, or logger do **not** hot-reload — you'll test stale code and
chase a ghost. Rule: after any edit, check whether the changed path is on that
list; if not, **restart the bot** before re-testing.

**Logs are JSON lines, two shapes** — grep both:

- Effect logger: `{"message":[…],"annotations":{"service":…}}`. Typed errors
  logged via `logEffect(…, { error })` land at `annotations.error` with `_tag` +
  a serialized `cause`.
- Legacy logger: `{"level":…,"service":…,"context":{}}`.

**DB read = strongest proof:** `sqlite3 ./mod-bot.sqlite3 '<query>'`.

## Capability 2 — Fix posture: immediate vs deferred

`qa-session` is findings-only. Here, decide per finding. Ask the human their
default posture up front, then treat each finding as a quick choice between
three dispositions:

- **Log-and-continue** — record observed-vs-expected in the run log, keep
  testing. Best for mapping a bug's blast radius _before_ fixing.
- **Stop-and-fix (immediate)** — the right call when the bug blocks the path
  under test. Mandatory steps, in order:
  1. Hand the fixer the **real evidence** — the actual error object/shape from
     the log, not a guess. (The classifier bug looked like a mock-shape issue;
     the real cause was deeper.)
  2. Require a regression test built from the **real** object, not a mock —
     mocks hid this class of bug entirely.
  3. After the fix, **restart the bot if the changed path isn't hot-reloaded**
     (Capability 1).
  4. Re-run the live check and confirm against the log/DB, not the Discord
     reply.
- **Defer-to-issue** — file a GitHub issue and move on. For findings outside the
  current work's scope (e.g. the 2026-06-20 member-applications flag-gating gap
  → `Euno-HQ/discord#379`).

## Capability 3 — Author a new checklist

When the work under test has no checklist, build one before testing. Procedure
(worked example: `error-handling.md`):

1. **Ground in code.** Read the code under test. For each user- or
   log-observable behavior, find the exact `file:line`, the user-facing copy,
   and the log marker / DB row that proves it.
2. **Triage every behavior** into one of:
   - **auto-verified** — a unit test already proves it → skip live, name the
     test in the checklist.
   - **human-triggerable** — needs a Discord action → becomes a checklist item.
   - **fault-injection-only** — can't be triggered from a Discord client (real
     5xx, rate-limit) → skip live, note the covering test.
3. **Write `do:` / `prove: local→… uat→…` / `pass:` triples** in the
   `qa-session` format, grounded with `file:line` and the real log markers / DB
   queries.

## Capability 4 — Re-validate checklists after new work (regression pass)

Checklists are living specs, not write-once docs. When a branch changes code,
re-ground the affected checklists against HEAD. This is subagent-friendly —
dispatch one to check drift and report. For each cited check:

- Do the `file:line` groundings still resolve? (code moves.)
- Did behavior change so a `pass:` is now wrong? (2026-06-20: collapsing
  `toUserResponse`'s operation-aware ForbiddenError branch made the old "kick
  shows generic copy, no hierarchy hint" expectation obsolete — kick now shows
  the same unified copy as ban.)
- Are there **new** behaviors needing checks? Did anything become — or stop
  being — auto-verified?

Update the checklist in place so the next run starts from truth.

## The deliverable

Not a findings-only PR comment. A `local-qa` pass produces: **fixes committed**,
**checklists updated**, and the **run log** (`.claude/qa-runs/<date>_local.md`)
summarizing what was tested, what passed, and what was deferred (with issue
links).

## Common mistakes

| Mistake                                                                  | Consequence                                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Running the bot from the worktree without copying the dev DB             | Empty DB, no guild — every feature looks broken                                                             |
| Using `npm run dev` instead of `dev:bot`                                 | `dev:init` reseeds and clobbers your copied guild data                                                      |
| Trusting hot-reload after editing `app/effects/` (or anything unwatched) | You test stale code and chase a phantom bug                                                                 |
| Trusting a green Discord reply                                           | The reply lies — the classifier bug returned user-visible copy while mistagging the error. Read the log/DB. |
| Fixing from a guessed error shape / mocked regression test               | The mock-vs-real gap is exactly what live QA exists to catch                                                |
