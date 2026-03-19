# Auto-Role on Join

## Summary

Automatically assign a configured role to members when they join the guild. This is a foundational feature that the member applications system (#329) builds upon to assign an "unverified" role to new members.

## Setting

Add `autoRole` to the `SETTINGS` constant in `app/models/guilds.server.ts`. Stores a single Discord role ID (string). Absent or null when disabled.

```typescript
export const SETTINGS = {
  modLog: "modLog",
  moderator: "moderator",
  restricted: "restricted",
  quorum: "quorum",
  deletionLog: "deletionLog",
  autoRole: "autoRole",        // new
} as const;
```

No migration required — the `guilds.settings` column is JSONB and handles new keys without schema changes.

## Setup Integration

Add an optional role selector to the setup form in `app/commands/setupHandlers.ts`, following the same pattern as the existing restricted role selector. The selected role ID is persisted through `setupAll.server.ts` via `setSettings()`.

This will appears as its own "page" of the setup flow, and will have a button to enable/disable the "apply to join" feature.

### Files modified

- `app/commands/setupHandlers.ts` — add role selector component to the setup form, update `PendingSetup` type with `autoRoleId` field
- `app/helpers/setupAll.server.ts` — persist `autoRole` in the `setSettings()` call

## Event Handler

New file: `app/discord/autoRole.ts`

Exports a function matching the pattern of other event handlers (e.g., `modActionLogger`, `onboardGuild`):

```typescript
export const autoRole = (client: Client) => {
  client.on(Events.GuildMemberAdd, (member) => {
    void runEffect(
      Effect.gen(function* () {
        const settings = yield* fetchSettingsEffect(member.guild.id, [SETTINGS.autoRole]);
        const roleId = settings.autoRole;
        if (!roleId) return;

        yield* Effect.tryPromise({
          try: () => member.roles.add(roleId),
          catch: (error) => new DiscordApiError({ operation: "addAutoRole", cause: error }),
        });

        yield* logEffect("info", "AutoRole", "Assigned auto-role to new member", {
          guildId: member.guild.id,
          userId: member.id,
          roleId,
        });
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

### Registration

Register in `app/server.ts` in the `Promise.allSettled` block alongside other event handlers:

```typescript
Promise.allSettled([
  onboardGuild(discordClient),
  automod(discordClient),
  modActionLogger(discordClient),
  autoRole(discordClient),          // new
  deployCommands(discordClient),
  // ...
])
```

## Error Handling

- **Role deleted by admin**: `member.roles.add()` will throw a Discord API error. Caught by `Effect.catchAll`, logged as a warning. The bot continues operating.
- **Bot lacks permissions**: Same handling — caught and logged.
- **No auto-role configured**: Early return, no-op.

All errors are non-fatal. A failure to assign auto-role should never crash the bot or block the member join event.

## Files Changed

| File | Change |
|------|--------|
| `app/models/guilds.server.ts` | Add `autoRole` to `SETTINGS` |
| `app/commands/setupHandlers.ts` | Add optional role selector to setup form, add `autoRoleId` to `PendingSetup` |
| `app/helpers/setupAll.server.ts` | Persist `autoRole` setting |
| `app/discord/autoRole.ts` | New file — `GuildMemberAdd` handler |
| `app/server.ts` | Register `autoRole` handler |

## Out of Scope

- Multiple auto-roles (single role only for now)
- Conditional role assignment (e.g., based on account age)
- Auto-role removal
