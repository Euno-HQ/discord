# Manual Membership Gate Activation — Implementation Plan

## Context

The membership approvals feature onboards a community by (1) assigning
`@Member` to all existing users and (2) locking down the server via
`@everyone` permission changes. For a 100k+ member community, Phase 1 can take
many hours. The current flow runs Phase 2 automatically after Phase 1, with no
moderator in the loop and no clear indication to the admin that the server is
in a half-configured state.

This plan introduces a manual confirmation step: Phase 1 runs asynchronously,
and a "Activate Membership Gate" button is posted to the mod-log when it
completes. A moderator clicks the button to trigger Phase 2.

## Goals

- Admin clearly understands the bulk role assignment is asynchronous
- Moderators are notified when Phase 1 completes
- Phase 2 (permission changes) requires explicit human confirmation
- Button works indefinitely until pressed (one-shot, no expiry)
- Preserve existing crash-recovery semantics

## Non-Goals

- Changing the signal-driven job runner architecture
- Adding rate limiting (discord.js handles 429s)
- Adding job priorities
- Changing the applicant runtime flow

## UX Flow

### 1. Setup confirmation (modified)

When admin clicks "Confirm ✓" in `/setup` with Member Applications enabled, the
synchronous setup still creates the role, channel, and Apply-to-Join button.
The "Setup Complete" message is rewritten to:

> ## Setup in Progress
>
> Created @Member role and #apply-here. Now assigning the Member role to all
> existing members — this can take several hours for large servers.
>
> You'll be notified in <#mod-log> when this is complete, where you can
> activate the membership gate.

### 2. Phase 1 completion notification (new)

Posted to mod-log when `bulk_role_assignment` completes successfully:

> ## Member role assignment complete
>
> Assigned @Member to **N** existing members.
>
> Click below when you're ready to activate the membership gate. This will:
> - Grant @Member permission to view channels
> - Deny @everyone permission to view channels (server-wide)
>
> New members will only see #apply-here until their application is approved.
>
> [ **Activate Membership Gate** ] (primary button)

### 3. Gate activation (new interaction)

When a moderator clicks the button:
- Verify caller has the mod role (use existing mod-role check pattern)
- Run Phase 2 logic (currently in `executePhase2Effect`)
- On success: edit the original message to remove the button and append a
  "✓ Gate activated by <@mod> at <time>" confirmation
- On failure: reply ephemerally with the error and leave the button active
  for retry

### 4. Phase 1 failure notification (modified copy)

> ## Member role assignment failed
>
> <error message>
>
> The membership gate has not been activated. Re-run `/setup` to retry.

## Implementation Steps

### Step 1 — Extract Phase 2 into a reusable effect

**File:** `app/jobs/bulkRoleAssignment.ts`

`executePhase2Effect` currently reads from the job row for `roleId`,
`everyonePermissions`, and `memberPermissions`. Extract the core logic into a
new exported effect that takes these as parameters:

```ts
export const activateMembershipGateEffect = (params: {
  guildId: string;
  roleId: string;
  everyonePermissions: bigint;
  memberPermissions: bigint;
}) => Effect.gen(function* () {
  // Grant @Member ViewChannel
  // Then deny @everyone ViewChannel
  // Rollback @Member on failure
});
```

The existing `executePhase2Effect` can call this, or be replaced by it.

### Step 2 — Remove automatic Phase 2 from the job handler

**File:** `app/jobs/bulkRoleAssignment.ts`

In `executeJobEffect`, after Phase 1 completes with zero errors, call
`completeJobEffect(job.id)` directly instead of `advancePhaseEffect`. Remove
the Phase 2 branch from the handler.

**File:** `app/helpers/setupAll.server.ts`

Change `createJob` call to `totalPhases: 1`.

### Step 3 — Enhance `notifyChannelEffect` for rich messages

**File:** `app/jobs/jobRunner.ts`

`notifyChannelEffect` currently sends `{ content: message }`. Refactor so
per-job-type notification builders can return a full Components V2 payload.

One approach: add an optional `buildNotification` function to the job handler
registry that takes the completed `Selectable<BackgroundJobs>` and returns
either a plain string or a Components V2 message body. Fall back to the
existing plain-text default if no builder is registered.

```ts
type JobNotificationBuilder = (job: Selectable<BackgroundJobs>) => {
  content?: string;
  flags?: number;
  components?: unknown[];
};

const notificationBuilders: Record<string, JobNotificationBuilder> = {
  bulk_role_assignment: buildGateActivationNotification,
};
```

### Step 4 — Build the gate activation notification

**File:** `app/jobs/bulkRoleAssignment.ts` (or a new file)

Export a `buildGateActivationNotification(job)` function that returns a
Components V2 container with:
- Header text and progress count
- An action row with a primary button:
  `customId: activate-gate|{guildId}`

The `guildId` is already stored on the job row.

### Step 5 — Add the `activate-gate` button handler

**File:** `app/commands/memberApplications.ts` (or a new `membershipGate.ts`)

Register a new component handler for `activate-gate|{guildId}`:

1. Parse `guildId` from `customId`
2. Verify `interaction.member` has the mod role (use `fetchSettingsEffect` to
   get `SETTINGS.modRole` and check `interaction.member.roles.cache`)
3. Load `application_config` by `guild_id` to get `role_id`
4. Fetch current `@everyone` and `@Member` permissions via
   `GET /guilds/{id}/roles` (or look them up from the job payload if still
   available — safer to re-fetch)
5. Call `activateMembershipGateEffect({ guildId, roleId, ... })`
6. On success:
   - `interactionUpdate` the original message to remove the button and append
     the activation confirmation
   - Optionally log to mod-log separately
7. On failure:
   - `interactionReply` ephemeral with the error
   - Leave the original message and button intact for retry

### Step 6 — Update the "Setup Complete" message

**File:** `app/commands/setupHandlers.ts`

Find the `buildSetupSuccessMessage` (or equivalent) that produces the green
"Setup Complete ✓" container. When Member Applications is enabled, change the
header and body to reflect the in-progress async state and point to mod-log.

When Member Applications is NOT enabled, keep the existing message unchanged.

### Step 7 — Tests

- `bulkRoleAssignment.test.ts`: update to assert that Phase 1 success marks
  the job `completed` (not `processing` with phase 2), and that no permission
  PATCH calls are made by the handler itself.
- New test for `activateMembershipGateEffect`: mock the REST client and verify
  the two PATCH calls are made in the correct order, and rollback fires on
  the second failure.
- New test for the `activate-gate` button handler: verify mod-role check,
  success path, and failure path.

## Edge Cases

- **Button clicked twice in rapid succession**: the second click should see
  the gate already active. We could rely on the `interactionUpdate` removing
  the button to prevent this, but a race is possible. The handler should be
  idempotent — check current `@everyone` permissions before patching; if
  ViewChannel is already denied, reply "Gate is already active" and edit the
  message accordingly.

- **Bot restarts after Phase 1 completes but before notification posts**: the
  job is marked `completed` but the mod-log message never went out. On boot,
  `runJobRunner` processes jobs but we'd need to ensure notification retry.
  Alternative: only mark `completed` after the notification succeeds.
  (Out of scope for this change? Flag as a known gap.)

- **Non-mod clicks the button**: ephemeral error reply, button stays active.

- **`application_config` row missing when button clicked**: shouldn't happen
  but guard with an error reply directing to re-run `/setup`.

## Open Questions

- Should we post a second mod-log message confirming gate activation, or only
  edit the original notification?
- When the original message is edited, should the button be replaced with a
  disabled "✓ Activated" button, or removed entirely?

## Files Touched

- `app/jobs/bulkRoleAssignment.ts`
- `app/jobs/jobRunner.ts`
- `app/helpers/setupAll.server.ts`
- `app/commands/setupHandlers.ts`
- `app/commands/memberApplications.ts` (or new `membershipGate.ts`)
- `app/jobs/bulkRoleAssignment.test.ts`
- New test files for the gate handler
