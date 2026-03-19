# Auto-Role on Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically assign a configured role to new members when they join a guild.

**Architecture:** New `autoRole` JSONB setting in the existing guild settings system, a `GuildMemberAdd` event handler in a new file, and setup form integration following the existing restricted role pattern.

**Tech Stack:** discord.js v14 (Events, GuildMember), Effect-TS (Effect.gen, Effect.tryPromise), Kysely (JSONB settings)

---

### Task 1: Add `autoRole` to guild settings model

**Files:**
- Modify: `app/models/guilds.server.ts:10-28`

- [ ] **Step 1: Add `autoRole` to `SETTINGS` constant**

In `app/models/guilds.server.ts`, add the new key to the `SETTINGS` object at line 15:

```typescript
export const SETTINGS = {
  modLog: "modLog",
  moderator: "moderator",
  restricted: "restricted",
  quorum: "quorum",
  deletionLog: "deletionLog",
  autoRole: "autoRole",
} as const;
```

- [ ] **Step 2: Add `autoRole` to `SettingsRecord` interface**

In the same file, add the optional field to `SettingsRecord` at line 27:

```typescript
interface SettingsRecord {
  [SETTINGS.modLog]: string;
  [SETTINGS.moderator]: string;
  [SETTINGS.restricted]?: string;
  [SETTINGS.quorum]?: number;
  [SETTINGS.deletionLog]?: string;
  [SETTINGS.autoRole]?: string;
}
```

- [ ] **Step 3: Verify the build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add app/models/guilds.server.ts
git commit -m "feat: add autoRole to guild settings model"
```

---

### Task 2: Create the `GuildMemberAdd` event handler

**Files:**
- Create: `app/discord/autoRole.ts`

- [ ] **Step 1: Create `app/discord/autoRole.ts`**

```typescript
import { Events, type Client } from "discord.js";
import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { DiscordApiError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";

export const autoRole = (client: Client) => {
  client.on(Events.GuildMemberAdd, (member) => {
    void runEffect(
      Effect.gen(function* () {
        const settings = yield* fetchSettingsEffect(member.guild.id, [
          SETTINGS.autoRole,
        ]);
        const roleId = settings.autoRole;
        if (!roleId) return;

        yield* Effect.tryPromise({
          try: () => member.roles.add(roleId),
          catch: (error) =>
            new DiscordApiError({ operation: "addAutoRole", cause: error }),
        });

        yield* logEffect(
          "info",
          "AutoRole",
          "Assigned auto-role to new member",
          {
            guildId: member.guild.id,
            userId: member.id,
            roleId,
          },
        );
      }).pipe(
        Effect.catchAll((error) =>
          logEffect("warn", "AutoRole", "Failed to assign auto-role", {
            guildId: member.guild.id,
            userId: member.id,
            error,
          }),
        ),
        Effect.withSpan("autoRole.assign", {
          attributes: { guildId: member.guild.id, userId: member.id },
        }),
      ),
    );
  });
};
```

Note: `fetchSettingsEffect` will fail with `NotFoundError` if the guild isn't registered. This is caught by the `Effect.catchAll`, which is the correct behavior — if the guild hasn't run `/setup`, auto-role should silently no-op.

- [ ] **Step 2: Verify the build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add app/discord/autoRole.ts
git commit -m "feat: add GuildMemberAdd handler for auto-role assignment"
```

---

### Task 3: Register the event handler in server startup

**Files:**
- Modify: `app/server.ts:101-113`

- [ ] **Step 1: Add import for `autoRole`**

Add to the imports section of `app/server.ts` (after the other discord imports around line 24):

```typescript
import { autoRole } from "#~/discord/autoRole";
```

- [ ] **Step 2: Register in `Promise.allSettled` block**

Add `autoRole(discordClient)` to the `Promise.allSettled` array at line 103:

```typescript
yield* Effect.tryPromise({
  try: () =>
    Promise.allSettled([
      onboardGuild(discordClient),
      automod(discordClient),
      modActionLogger(discordClient),
      autoRole(discordClient),
      deployCommands(discordClient),
      startActivityTracking(discordClient),
      startDeletionLogging(discordClient),
      startReactjiChanneler(discordClient),
    ]),
  catch: (error) => new DiscordApiError({ operation: "init", cause: error }),
});
```

- [ ] **Step 3: Verify the build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add app/server.ts
git commit -m "feat: register autoRole event handler at startup"
```

---

### Task 4: Integrate auto-role into setup form

**Files:**
- Modify: `app/commands/setupHandlers.ts:23-31, 49-67, 119-319, 321-373, 541-677`
- Modify: `app/helpers/setupAll.server.ts:25-33, 83-151`

- [ ] **Step 1: Add `autoRoleId` to `PendingSetup` interface**

In `app/commands/setupHandlers.ts`, add the field to `PendingSetup` (line 29):

```typescript
interface PendingSetup {
  modRoleId?: string;
  modLogChannel: string;
  deletionLogChannel: string | null;
  honeypotChannel: string | null;
  ticketChannel: string | null;
  restrictedRoleId?: string;
  autoRoleId?: string;           // new — role to assign on join
  createdAt: number;
}
```

- [ ] **Step 2: Add `autoRole` to `FIELD_MAP` and `defaultSetup()`**

Update `defaultSetup()` to include the new field (line 51):

```typescript
function defaultSetup(): Omit<PendingSetup, "createdAt"> {
  return {
    modRoleId: undefined,
    modLogChannel: CREATE_SENTINEL,
    deletionLogChannel: CREATE_SENTINEL,
    honeypotChannel: CREATE_SENTINEL,
    ticketChannel: CREATE_SENTINEL,
    restrictedRoleId: undefined,
    autoRoleId: undefined,
  };
}
```

Update `FIELD_MAP` to include the mapping (line 66):

```typescript
const FIELD_MAP = {
  modRole: "modRoleId",
  modLog: "modLogChannel",
  deletionLog: "deletionLogChannel",
  honeypot: "honeypotChannel",
  tickets: "ticketChannel",
  restrictedRole: "restrictedRoleId",
  autoRole: "autoRoleId",
} as const;
```

- [ ] **Step 3: Add role selector to setup form UI**

Note: The spec mentions this page will eventually have a button to enable/disable the "apply to join" feature — that's part of the member applications feature (#329) and will be added later.

In `buildSetupFormMessage()`, add an auto-role section after the restricted role block (after line 296). Insert before the `{ type: ComponentType.Separator }` and feature toggle row:

```typescript
{ type: ComponentType.Separator },
{
  type: ComponentType.TextDisplay,
  content:
    "**Auto-Role on Join** *(optional)* — Role automatically assigned to new members when they join.",
},
{
  type: ComponentType.ActionRow,
  components: [
    {
      type: ComponentType.RoleSelect,
      custom_id: `setup-sel|${guildId}|autoRole`,
      placeholder: "None — skip (default)",
      ...(state.autoRoleId
        ? {
            default_values: roleDefaultValues(state.autoRoleId),
          }
        : {}),
    },
  ],
},
```

- [ ] **Step 4: Add auto-role to confirmation summary**

In `buildSetupConfirmMessage()`, add a line to `summaryLines` (after the restricted role line, around line 328):

```typescript
`**Auto-Role on Join:** ${state.autoRoleId ? `<@&${state.autoRoleId}>` : "None"}`,
```

- [ ] **Step 5: Add auto-role to completion status**

In the `setup-exec` handler's `statusLines` array (around line 605), add:

```typescript
...(state.autoRoleId
  ? [`**Auto-Role on Join:** <@&${state.autoRoleId}>`]
  : []),
```

- [ ] **Step 6: Pass `autoRoleId` to `setupAll()`**

In the `setup-exec` handler (line 562), add `autoRoleId` to the `setupAll()` call:

```typescript
const result = yield* Effect.tryPromise(() =>
  setupAll({
    guildId,
    moderatorRoleId: state.modRoleId!,
    restrictedRoleId: state.restrictedRoleId,
    autoRoleId: state.autoRoleId,
    modLogChannel: state.modLogChannel,
    deletionLogChannel: state.deletionLogChannel ?? undefined,
    honeypotChannel: state.honeypotChannel ?? undefined,
    ticketChannel: state.ticketChannel ?? undefined,
  }),
);
```

- [ ] **Step 7: Update `SetupAllOptions` and `setupAll()` to persist `autoRole`**

In `app/helpers/setupAll.server.ts`, add `autoRoleId` to `SetupAllOptions` (line 28):

```typescript
export interface SetupAllOptions {
  guildId: string;
  moderatorRoleId: string;
  restrictedRoleId?: string;
  autoRoleId?: string;             // new
  modLogChannel: string;
  deletionLogChannel?: string;
  honeypotChannel?: string;
  ticketChannel?: string;
}
```

Destructure it in `setupAll()` (line 89):

```typescript
const {
  guildId,
  moderatorRoleId,
  restrictedRoleId,
  autoRoleId,
  modLogChannel,
  deletionLogChannel,
  honeypotChannel,
  ticketChannel,
} = options;
```

Add it to the `setSettings()` call (line 144):

```typescript
await setSettings(guildId, {
  [SETTINGS.modLog]: modLogChannelId,
  [SETTINGS.moderator]: moderatorRoleId,
  [SETTINGS.restricted]: restrictedRoleId,
  ...(deletionLogChannelId
    ? { [SETTINGS.deletionLog]: deletionLogChannelId }
    : {}),
  ...(autoRoleId ? { [SETTINGS.autoRole]: autoRoleId } : {}),
});
```

- [ ] **Step 8: Verify the build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add app/commands/setupHandlers.ts app/helpers/setupAll.server.ts
git commit -m "feat: integrate auto-role selection into setup flow"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test the setup flow**

1. Run `/setup` in a Discord test server
2. Verify the auto-role selector appears in the form after the restricted role selector
3. Select a role for auto-role
4. Click Continue and verify the confirmation shows the selected auto-role
5. Click Confirm and verify setup completes successfully

- [ ] **Step 3: Test auto-role assignment**

1. Have a test account join the server (or use a bot to simulate)
2. Verify the configured role is automatically assigned
3. Check logs for the "Assigned auto-role to new member" message

- [ ] **Step 4: Test error cases**

1. Delete the auto-role from the server, have someone join — verify warning logged, no crash
2. Run `/setup` without selecting an auto-role — verify it works without auto-role (no regression)
