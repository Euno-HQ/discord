# Membership gate (member applications) - DEPRECATED EXPLORATION

Nothing in `app/` imports this directory. It is kept compiling and tested so it can be revived, but it is not registered, deployed, or reachable from `/setup`.

## What it did

New members land in a hidden-by-default server where `@everyone` is denied ViewChannel. A `#apply-here` channel hosts an "Apply to Join" button; applicants fill a modal, mods review it in a private thread and approve (grants the Member role) or deny. Turning the gate on first bulk-assigned the Member role to every existing member (`bulkRoleAssignment.ts`, a resumable background job), then a mod-log button flipped @everyone's permissions (`activateMembershipGateEffect`).

## Why it was shelved

Bulk role assignment needs to enumerate every member (List Guild Members endpoint), which requires the privileged GuildMembers intent. Discord revoked that intent in 2026-09 and we are permanently operating without it. Without enumeration, the gate cannot safely grant the Member role to existing members before denying @everyone, so turning it on would lock everyone out.

## What it would take to revive

- Get the GuildMembers intent re-approved (re-add the intent flag in `app/discord/intents.ts` and `client.server.ts`), or
- Redesign to gate only new joiners, e.g. via Discord Onboarding / Rules Screening or an opt-in button, so no existing-member sweep is needed.

## Where it hooked in (all removed from live code)

- `app/server.ts`: `registerCommand(memberApplications)` and `import "#~/jobs/bulkRoleAssignment"` (registers the `bulk_role_assignment` job handler with `jobRunner`; unregistered jobs now fail with "Unknown job type").
- `app/helpers/setupAll.server.ts`: the "Member application channel" block (create `#apply-here`, post the button, upsert `application_config`, create the `bulk_role_assignment` job) and the `memberRole` / `applicationChannel` settings writes.
- `app/commands/setupHandlers.ts`: `applicationChannel` / `memberRoleId` wizard fields, the channel/role selects, confirm-screen rows and delta text, the "Setup in Progress" message.
- `app/commands/checkRequirements.ts`: the "Member applications" checks (Application Channel, Apply Button, Channel Gating, Member Role).
- `app/helpers/setupPermissionCheck.ts`: the `applicationChannel` slot.
- `app/commands/report/modActionLogger.ts`: called `resolveApplicationsForDeparture(guild.id, user.id)` from the GuildMemberRemove handler (that event also needed the revoked intent).
- `app/routes/features.tsx`: marketing copy.

## Residue left in place

- DB tables/migrations (`application_config`, application tables) untouched.
- Settings keys `memberRole` / `applicationChannel` in `SETTINGS` (`app/models/guilds.server.ts`); existing guild rows may still hold them.
- `member-applications` PostHog flag in `app/effects/featureFlags.ts`.
