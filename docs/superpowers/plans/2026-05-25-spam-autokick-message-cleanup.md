# Spam Auto-Kick Message Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the spam pipeline's auto-kick with a softban (ban + immediate unban) that uses `deleteMessageSeconds=3600` so Discord deletes the user's last hour of messages server-side, resolving issue #343.

**Architecture:** Extract a shared `softbanMember(member, reason, deleteSeconds)` helper that fixes a latent error-handling bug in the existing honeypot path (where a failing unban after a successful ban left the user banned silently). Use the helper in both the auto-kick branch and the existing honeypot path. All edits live in a single file.

**Tech Stack:** TypeScript, Effect-TS, discord.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-spam-autokick-message-cleanup-design.md`

---

## File Structure

**Modify:**
- `app/features/spam/spamResponseHandler.ts` — add `softbanMember` helper, replace `member.kick(...)` with it in the auto-kick branch, refactor existing `executeSoftban` to use it, update mod-log reply text.
- `app/features/spam/spamResponseHandler.test.ts` — add three tests for `softbanMember`.

No new files. No other modules touched.

---

### Task 1: Add `softbanMember` helper with tests

**Files:**
- Modify: `app/features/spam/spamResponseHandler.ts` (add helper near the top, after the `crossGuildDmSent` declaration around line 38)
- Modify: `app/features/spam/spamResponseHandler.test.ts` (add three tests)

We're test-driving the helper because the unban-on-success-ban guarantee is the only new invariant in this change. Two of the three tests verify error paths; the third is the happy path.

The mocking strategy mirrors `app/helpers/setupPermissionCheck.test.ts:24-31`: cast a minimal object literal to `unknown as GuildMember`. We need `member.ban`, `member.id`, `member.guild.id`, and `member.guild.members.unban` to be observable.

- [ ] **Step 1: Export the helper symbol from `spamResponseHandler.ts`**

We need to export `softbanMember` so the test file can import it. Add to the existing exports — no implementation yet.

At the top of `app/features/spam/spamResponseHandler.ts`, after the existing imports and `CROSS_GUILD_SPAM_THRESHOLD`/`crossGuildDmSent` declarations (around line 38), add the declaration only:

```ts
/**
 * Ban a member to delete their recent messages, then immediately unban so
 * they can rejoin a clean invite. Discord deletes messages server-side based
 * on `deleteMessageSeconds`. Splits ban and unban into separate Effect steps
 * so that a failing unban after a successful ban is logged as the operational
 * incident it is — a user left banned — rather than swallowed alongside the
 * ban error.
 */
export const softbanMember = (
  member: GuildMember,
  reason: string,
  deleteMessageSeconds: number,
): Effect.Effect<void, never> => Effect.never as never;
```

(`Effect.never as never` is a placeholder so the import compiles; the next steps replace it with the real body.)

- [ ] **Step 2: Write the failing tests**

Append to `app/features/spam/spamResponseHandler.test.ts`:

```ts
import { Effect } from "effect";
import type { GuildMember } from "discord.js";

import { softbanMember } from "./spamResponseHandler";

// ── softbanMember ──
// The helper splits ban and unban so that a failing unban after a successful
// ban is observable as a distinct operational incident (user left banned),
// not swallowed alongside ban failures.

function makeMemberMock(opts: {
  banImpl?: () => Promise<unknown>;
  unbanImpl?: () => Promise<unknown>;
} = {}) {
  const banSpy = vi.fn(opts.banImpl ?? (() => Promise.resolve()));
  const unbanSpy = vi.fn(opts.unbanImpl ?? (() => Promise.resolve()));
  const member = {
    id: "user-1",
    ban: banSpy,
    guild: {
      id: "guild-1",
      members: { unban: unbanSpy },
    },
  } as unknown as GuildMember;
  return { member, banSpy, unbanSpy };
}

test("softbanMember calls ban then unban on the happy path", async () => {
  const { member, banSpy, unbanSpy } = makeMemberMock();

  await Effect.runPromise(softbanMember(member, "test reason", 3600));

  expect(banSpy).toHaveBeenCalledWith({
    reason: "test reason",
    deleteMessageSeconds: 3600,
  });
  expect(unbanSpy).toHaveBeenCalledWith(member, "test reason");
  // unban runs strictly after ban
  expect(banSpy.mock.invocationCallOrder[0]).toBeLessThan(
    unbanSpy.mock.invocationCallOrder[0],
  );
});

test("softbanMember does not call unban when ban itself fails", async () => {
  const { member, banSpy, unbanSpy } = makeMemberMock({
    banImpl: () => Promise.reject(new Error("missing permissions")),
  });

  await Effect.runPromise(softbanMember(member, "test reason", 3600));

  expect(banSpy).toHaveBeenCalledTimes(1);
  expect(unbanSpy).not.toHaveBeenCalled();
});

test("softbanMember absorbs unban failure (user left banned is logged, not thrown)", async () => {
  const { member, banSpy, unbanSpy } = makeMemberMock({
    unbanImpl: () => Promise.reject(new Error("network error")),
  });

  // Must not throw — the helper's job is to log this and continue.
  await expect(
    Effect.runPromise(softbanMember(member, "test reason", 3600)),
  ).resolves.toBeUndefined();

  expect(banSpy).toHaveBeenCalledTimes(1);
  expect(unbanSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run app/features/spam/spamResponseHandler.test.ts`
Expected: the three new `softbanMember` tests fail (the helper returns `Effect.never`, so `runPromise` hangs — Vitest will eventually time out, which counts as failure). The pre-existing tests in the file continue to pass.

- [ ] **Step 4: Implement the helper**

Replace the placeholder body from Step 1 in `app/features/spam/spamResponseHandler.ts` with the real implementation:

```ts
/**
 * Ban a member to delete their recent messages, then immediately unban so
 * they can rejoin a clean invite. Discord deletes messages server-side based
 * on `deleteMessageSeconds`. Splits ban and unban into separate Effect steps
 * so that a failing unban after a successful ban is logged as the operational
 * incident it is — a user left banned — rather than swallowed alongside the
 * ban error.
 */
export const softbanMember = (
  member: GuildMember,
  reason: string,
  deleteMessageSeconds: number,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      member.ban({ reason, deleteMessageSeconds }),
    ).pipe(
      Effect.catchAll((error) =>
        logEffect("error", "SpamResponse", "Softban: ban failed", {
          error: String(error),
          userId: member.id,
          guildId: member.guild.id,
        }).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    yield* Effect.tryPromise(() =>
      member.guild.members.unban(member, reason),
    ).pipe(
      Effect.catchAll((error) =>
        logEffect(
          "error",
          "SpamResponse",
          "Softban: ban succeeded but unban failed — user is BANNED",
          { error: String(error), userId: member.id, guildId: member.guild.id },
        ),
      ),
    );
  }).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.withSpan("SpamResponse.softbanMember"),
  );
```

Why the structure looks like this:

- The outer `catchAll(() => Effect.void)` is what makes the function's error channel `never`. The ban-failure branch logs and re-fails so the outer catchAll converts it to `void` AND skips the unban. The unban-failure branch logs and succeeds, so unban completion errors do not prevent the helper from returning.
- The net effect: ban error → unban skipped, helper returns void. Unban error → logged loudly, helper returns void. Both succeed → helper returns void. The helper never throws.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/features/spam/spamResponseHandler.test.ts`
Expected: all tests pass, including the three new `softbanMember` tests.

- [ ] **Step 6: Commit**

```bash
git add app/features/spam/spamResponseHandler.ts app/features/spam/spamResponseHandler.test.ts
git commit -m "$(cat <<'EOF'
feat(spam): add softbanMember helper with safe ban/unban split

Splits ban and unban into separate Effect steps so a failing unban after
a successful ban is logged as the operational incident it is (user left
banned) rather than silently swallowed with the ban error.

Prep for #343 — auto-kick will become a softban with 1h message cleanup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Use `softbanMember` in the auto-kick branch

**Files:**
- Modify: `app/features/spam/spamResponseHandler.ts:117-125` (the auto-kick `member.kick(...)` call and its `catchAll`)
- Modify: `app/features/spam/spamResponseHandler.ts:142` (the mod-log reply text)

This is the behavior change that resolves #343. Two small textual edits in `executeResponse`.

- [ ] **Step 1: Replace the kick call with softbanMember**

In `app/features/spam/spamResponseHandler.ts`, locate this block in the auto-kick branch (currently lines 117–125):

```ts
        yield* Effect.tryPromise(() =>
          member.kick("Autokicked for repeated spam"),
        ).pipe(
          Effect.catchAll((error) =>
            logEffect("warn", "SpamResponse", "Failed to kick spammer", {
              error: String(error),
            }),
          ),
        );
```

Replace with:

```ts
        yield* softbanMember(
          member,
          "Autokicked for repeated spam (1h message cleanup)",
          3600,
        );
```

(No `catchAll` wrapper needed — `softbanMember`'s error channel is already `never` and it logs failures internally.)

- [ ] **Step 2: Update the mod-log reply text**

In the same function, locate the `logMessage.reply` call (currently line 141-144):

```ts
            logMessage.reply({
              content: `Automatically kicked <@${userId}> for spam`,
              allowedMentions: {},
            }),
```

Replace with:

```ts
            logMessage.reply({
              content: `Automatically removed <@${userId}> for spam (last hour of messages also deleted)`,
              allowedMentions: {},
            }),
```

- [ ] **Step 3: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: no type errors.

Run: `npx vitest run app/features/spam/spamResponseHandler.test.ts`
Expected: all tests still pass (no behavioral test exercises this branch yet, and the type-level change is internal to `executeResponse`).

- [ ] **Step 4: Commit**

```bash
git add app/features/spam/spamResponseHandler.ts
git commit -m "$(cat <<'EOF'
feat(spam): auto-kick now softbans with 1h message cleanup (#343)

Replaces member.kick() in the auto-kick branch with softbanMember(...,
3600). Discord deletes the user's last hour of messages server-side,
catching messages that race ahead of detection and first messages that
scored tier=none before velocity signals could fire.

The user is removed from the guild (same outcome as kick) and can rejoin
a clean invite. Mod-log reply text updated to reflect the cleanup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Refactor the honeypot `executeSoftban` to use the shared helper

**Files:**
- Modify: `app/features/spam/spamResponseHandler.ts:310-338` (the `executeSoftban` function)

DRY. The honeypot path predates the new helper but does exactly the same thing — ban + unban. Convert it to use `softbanMember` so the safer error split applies there too.

- [ ] **Step 1: Replace the honeypot ban+unban block with a call to the helper**

In `app/features/spam/spamResponseHandler.ts`, find the `executeSoftban` function (currently lines 310–338):

```ts
/** Execute a softban (ban + unban) for honeypot triggers */
const executeSoftban = (
  message: Message,
  member: GuildMember,
  verdict: SpamVerdict,
) =>
  Effect.gen(function* () {
    const guild = message.guild!;

    yield* Effect.tryPromise(async () => {
      await member.ban({
        reason: "honeypot spam detected",
        deleteMessageSeconds: 604800, // 7 days
      });
      await guild.members.unban(member);
    }).pipe(
      Effect.catchAll((error) =>
        logEffect("error", "SpamResponse", "Failed to softban user", {
          error: String(error),
          userId: member.id,
          guildId: guild.id,
        }),
      ),
    );

    yield* logSpamReport(message, verdict);

    featureStats.honeypotTriggered(guild.id, member.id, message.channelId);
  }).pipe(Effect.withSpan("SpamResponse.executeSoftban"));
```

Replace with:

```ts
/** Execute a softban (ban + unban) for honeypot triggers — 7-day message wipe. */
const executeSoftban = (
  message: Message,
  member: GuildMember,
  verdict: SpamVerdict,
) =>
  Effect.gen(function* () {
    yield* softbanMember(member, "honeypot spam detected", 604800);
    yield* logSpamReport(message, verdict);
    featureStats.honeypotTriggered(
      message.guild!.id,
      member.id,
      message.channelId,
    );
  }).pipe(Effect.withSpan("SpamResponse.executeSoftban"));
```

- [ ] **Step 2: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: no type errors.

Run: `npx vitest run app/features/spam/spamResponseHandler.test.ts`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/features/spam/spamResponseHandler.ts
git commit -m "$(cat <<'EOF'
refactor(spam): honeypot softban uses shared softbanMember helper

Replaces the inline ban+unban block in executeSoftban with a call to the
new helper. Behavior is equivalent except that a failing unban after a
successful ban now logs at error level as a distinct incident, not
swallowed alongside the ban error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Final verification

**Files:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: no errors (warnings tolerated only if they already existed on `main`).

- [ ] **Step 3: Confirm the diff matches the spec**

Run: `git diff main..HEAD -- app/features/spam/spamResponseHandler.ts | head -200`
Expected: a single file with the `softbanMember` helper added, the auto-kick branch using it, the honeypot `executeSoftban` simplified, and the mod-log reply text updated. No other changes.

If any of these checks fail, fix the underlying issue and amend the relevant task's commit (or add a follow-up commit). Do NOT skip these checks.

---

## Self-review notes

- **Spec coverage:**
  - "Replace `member.kick(...)` with `softbanMember(...)` (3600s)" → Task 2 Step 1. ✓
  - "Extract `softbanMember` helper with safe ban/unban split" → Task 1. ✓
  - "Refactor existing `executeSoftban` to use the helper" → Task 3. ✓
  - "Update the mod-log reply text" → Task 2 Step 2. ✓
  - "Tests for `softbanMember`: unban runs after success, unban does not run when ban fails, unban failure is logged loudly" → Task 1 Step 2. ✓
  - The spec also called for "Replace any assertion that `member.kick` was called in the auto-kick path." There are no such assertions today (verified — `spamResponseHandler.test.ts` only tests constants and pure helpers), so no edits needed.
- **No placeholders.** All code shown in full at the point of use.
- **Type consistency.** `softbanMember(member, reason, deleteMessageSeconds)` signature is identical in every reference.
