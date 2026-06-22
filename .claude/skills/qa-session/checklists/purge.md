# Purge command (#364)

Grounding: `app/commands/purgeMessages.ts`. No DB writes — purge is read-only;
proof is Discord-observable + log lines (service `Commands`).

Log markers (all info, with `guildId`, `moderatorUserId`, `targetUserId`):
- invoked → `"Purge messages command invoked"` (:111)
- dropdown changed → `"Purge messages duration selected"` (:182)
- confirmed → `"Purge messages confirmed"` (:239)
- done → `"Purge messages completed"` with `deletedCount` (:328)

Gotcha to probe: per-channel scan wraps each channel in `try/catch` that **silently
swallows** errors (`:321-324`) — a channel the bot can't read is skipped with no
per-channel log, so `deletedCount` can under-count silently.

---

## Batch A — confirm-button flow on a real target
Pick a target who **actually has recent messages**. Invoke the purge command on
them (user context-menu). Ping me after the menu renders, again after confirming.

### A1 renders with default + no accidental delete
do:    open the command; observe the duration dropdown (defaults to **24h**) and a red/Danger "Delete messages" button; change the dropdown selection
prove: local → grep `"Purge messages command invoked"`; on changing the dropdown, grep `"Purge messages duration selected"` and confirm NO `"Purge messages completed"` yet. Discord: nothing deleted.
       uat   → same log sequence; no deletion.
pass:  menu shows 24h default + Delete button; changing the selection does not delete.

### A2 confirm → pending → count
do:    click "Delete messages"
prove: local → within ~1s the reply switches to a "Purging…" pending state and the controls disappear; grep `"Purge messages confirmed"` then `"Purge messages completed"` with `deletedCount`. Cross-check the count against what the target visibly had.
       uat   → pending state shown; completed log carries `deletedCount`.
pass:  pending state appears, controls removed, final `deletedCount` matches the visible messages purged.

### A3 silent per-channel skip awareness
do:    (same run) if the target had messages in a channel the bot can't read
prove: local → note whether `deletedCount` is lower than the true total with no error surfaced (the swallowed `catch`). Record observed vs expected — this is a known sharp edge, not a regression to fix here.
       uat   → same observation.
pass:  finding recorded; flag if count under-counts silently.

---

## Batch B — edge cases
### B1 zero-message target
do:    purge a user who has no recent messages in range
prove: local → completes with `deletedCount` 0; grep `"Purge messages completed"`; reply reads as "Deleted 0", not an error.
       uat   → completed log with count 0.
pass:  graceful "0 deleted", no error.

### B2 permission gating
do:    attempt to invoke the command as a user **without** Manage Messages
prove: local → command is hidden or denied (Discord enforces `ManageMessages`, `:106`); no `"Purge messages command invoked"` log for that user.
       uat   → command unavailable / denied.
pass:  unprivileged user cannot invoke it.
