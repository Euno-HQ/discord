# Spam Auto-Kick Message Cleanup

Resolves GitHub issue [#343](https://github.com/reactiflux/mod-bot/issues/343):
when the spam pipeline auto-kicks a user, also delete every message that user
sent in the guild within the last hour.

## Problem

The current auto-kick path leaves a small but consistent trail of garbage that
mods clean up by hand:

1. **Detection lag.** A burst of spam can post 1–3 messages faster than the bot
   processes them, so messages slip out before kick.
2. **First-message blind spot.** Velocity signals (duplicates, rapid-fire,
   channel-hop) require multiple messages to fire. The very first spam message
   often scores `tier=none` and is never recorded in `reported_messages`, so
   the post-kick cleanup (`deleteAllReportedForUser`) doesn't touch it.

Today's auto-kick flow (`app/features/spam/spamResponseHandler.ts:112-148`)
calls `member.kick(...)` then `deleteAllReportedForUser(userId, guildId)`,
which only deletes messages already written to the `reported_messages` table.

## Solution

Replace the `member.kick(...)` call in the auto-kick branch with a softban —
`member.ban({ deleteMessageSeconds: 3600 })` followed immediately by
`guild.members.unban(member)`. Discord deletes every message the user sent in
the guild within the last hour, server-side. The user is removed from the
guild and free to rejoin a clean invite — functionally identical to a kick.

This mirrors the existing honeypot path (`executeSoftban`), which already uses
softban with a 7-day delete window. The auto-kick path just gets a shorter
window.

## Scope

**In scope:** the spam auto-kick trigger (≥3 cumulative high-tier reports in
the same guild).

**Out of scope:** honeypot (already softbans with 7d), medium/high single
responses (delete + restrict/timeout, no kick), manual mod kicks via the
report flow.

## Code changes

All edits live in `app/features/spam/spamResponseHandler.ts`.

### 1. Extract `softbanMember` helper

Pull the ban+unban pattern into a small Effect-returning helper:

```ts
const softbanMember = (
  member: GuildMember,
  reason: string,
  deleteMessageSeconds: number,
) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      member.ban({ reason, deleteMessageSeconds }),
    );
    yield* Effect.tryPromise(() => member.guild.members.unban(member, reason))
      .pipe(
        Effect.catchAll((error) =>
          logEffect(
            "error",
            "SpamResponse",
            "Softban: ban succeeded but unban failed — user is BANNED",
            { error: String(error), userId: member.id, guildId: member.guild.id },
          ),
        ),
      );
  });
```

The split matters: the existing honeypot path wraps `ban` and `unban` in a
single `tryPromise`, so a thrown `unban` after a successful `ban` leaves the
user banned with no log line indicating why. The new helper logs that
specific failure mode loudly.

### 2. Use it in the auto-kick branch

Replace lines 117–125 (the `member.kick(...)` call and its `catchAll`) with:

```ts
yield* softbanMember(
  member,
  "Autokicked for repeated spam (1h message cleanup)",
  3600,
).pipe(
  Effect.catchAll((error) =>
    logEffect("warn", "SpamResponse", "Failed to softban spammer", {
      error: String(error),
    }),
  ),
);
```

The downstream calls — `deleteAllReportedForUser`, the mod-log reply,
`featureStats.spamKicked`, and `checkCrossGuildSpam` — all stay exactly as
they are. `deleteAllReportedForUser` is still useful because:

- It marks the now-Discord-deleted recent messages as deleted in
  `reported_messages` (audit-trail accuracy).
- It actually deletes any older messages from prior spam reports that fall
  outside the 1-hour Discord-side window.

### 3. Refactor `executeSoftban` to use the helper

The honeypot path (lines 310–338) becomes:

```ts
const executeSoftban = (
  message: Message,
  member: GuildMember,
  verdict: SpamVerdict,
) =>
  Effect.gen(function* () {
    yield* softbanMember(member, "honeypot spam detected", 604800).pipe(
      Effect.catchAll((error) =>
        logEffect("error", "SpamResponse", "Failed to softban user", {
          error: String(error),
          userId: member.id,
          guildId: message.guild!.id,
        }),
      ),
    );
    yield* logSpamReport(message, verdict);
    featureStats.honeypotTriggered(message.guild!.id, member.id, message.channelId);
  }).pipe(Effect.withSpan("SpamResponse.executeSoftban"));
```

### 4. Update the mod-log reply text

Line 142 currently reads:

```ts
content: `Automatically kicked <@${userId}> for spam`,
```

Change to:

```ts
content: `Automatically removed <@${userId}> for spam (last hour of messages also deleted)`,
```

The `featureStats.spamKicked` metric name stays — it preserves dashboard
continuity and the event is semantically the same outcome.

## Tests

`app/features/spam/spamResponseHandler.test.ts` (or wherever the auto-kick
branch is exercised today):

- Replace any assertion that `member.kick` was called in the auto-kick path
  with assertions that `member.ban` was called with
  `{ deleteMessageSeconds: 3600 }` and that `guild.members.unban` was called
  afterward.
- Add a unit test for `softbanMember`: when `ban` succeeds but `unban` throws,
  the error is logged at level `error` with a message indicating the user is
  banned, and the overall Effect does not fail.
- Add a unit test for `softbanMember`: when `ban` itself fails, `unban` is
  NOT called.
- Existing honeypot test should still pass after the refactor since the
  observable behavior of `executeSoftban` is unchanged.

## Risks

| Risk | Mitigation |
|------|------------|
| Audit log shows ban+unban instead of kick | Acceptable — mod review uses the bot's own mod-log thread, not Discord's audit log. |
| Ban succeeds, unban fails → user is banned | New helper logs this loudly at error level. Acceptable rate of occurrence; mods can manually unban from the logged context. |
| Ban→unban window briefly shows user as banned | Same property exists in honeypot path today; no real-world impact. |
| `deleteMessageSeconds` hardcoded to 3600 | Per issue spec ("~1hr"). YAGNI — no configurability until a second use case appears. |
| Bot lacks BAN_MEMBERS permission in a guild | Bot already requires this for honeypot; not a new dependency. |

## Out-of-scope follow-ups

- Extending the in-memory `recentActivityTracker` window. Softban makes this
  unnecessary for cleanup; the tracker only needs to retain enough history
  for detection signals (current 30 min / 20 msgs is fine).
- Applying the same cleanup to manual mod kicks for spam. Possible future
  work, but #343 only calls out the auto-kick case.
- Making the deletion window configurable per-guild.
