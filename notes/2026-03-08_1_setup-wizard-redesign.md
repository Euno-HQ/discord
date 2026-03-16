# Setup Wizard Redesign — 3-Step Flow

## Steps

### Step 1: Required
- Moderator role (required, validated before next/confirm)
- Mod log channel (defaults to CREATE_SENTINEL)
- Buttons: [Next →] [Confirm ✓]

### Step 2: Recommended
- Deletion log (toggle + channel select)
- Honeypot (toggle + channel select)
- Ticket channel (toggle + channel select)
- Buttons: [← Back] [Next →] [Confirm ✓]

### Step 3: Continue Configuring
- StringSelect dropdown of named features
- When selected, shows that feature's config UI below the dropdown
- Available features:
  - Restricted Role — RoleSelect
  - Quorum — StringSelect (2–7)
- Buttons: [← Back] [Confirm ✓]

## Behavior
- **Confirm** at any step executes all accumulated state up to that point
- **Next** advances to the next step (step 1 validates mod role first)
- **Back** returns to previous step with state preserved
- Step 3 dropdown controls which feature's UI is visible; multiple features
  can be configured before confirming

## custom_id scheme
- `setup-sel|{guildId}|{field}` — select menus
- `setup-sel|{guildId}|{field}|enable|disable` — toggle buttons
- `setup-next|{guildId}` — advance step
- `setup-back|{guildId}` — go back
- `setup-exec|{guildId}` — confirm and execute

## State
```typescript
interface PendingSetup {
  step: 1 | 2 | 3;
  // Step 1
  modRoleId?: string;
  modLogChannel: string;
  // Step 2
  deletionLogChannel: string | null;
  honeypotChannel: string | null;
  ticketChannel: string | null;
  // Step 3
  selectedFeature?: string;
  restrictedRoleId?: string;
  quorum?: number;
  createdAt: number;
}
```

## Files changed
- `app/commands/setupHandlers.ts` — major rewrite (state, form builders, handlers)
- `app/helpers/setupAll.server.ts` — add quorum to SetupAllOptions
- `app/models/guilds.server.ts` — quorum already in SETTINGS, just needs to be written
