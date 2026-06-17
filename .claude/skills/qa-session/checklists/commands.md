# Commands & setup: escalation, member apps, setup/honeypot/tickets/reactji, force-ban, modreport, track

Grounding: `app/commands/escalate/*`, `app/discord/escalationResolver.ts`,
`app/commands/memberApplications.ts`, `app/commands/setupHandlers.ts` +
`app/helpers/setupAll.server.ts`, `setupHoneypot.ts`, `setupTickets.ts`,
`setupReactjiChannel.ts`, `force-ban.ts`, `modreport.ts`, `track.ts`.
Tables: `escalations`, `escalation_records`, `applications`, `honeypot_config`,
`tickets_config`, `reactji_channeler_config`, `reported_messages`.

Setup ordering gotcha (verify it's honored): channels/roles must be created
**before** `@everyone` permissions are modified (`setupAll.server.ts`). A guild
left with VIEW_CHANNELS denied but no member role = the failure mode.

---

## Batch A — guild setup (use a fresh test guild if possible)
Run `/setup` and walk the flow to completion. Ping me.

### A1 provisions channels/roles then perms
do:    complete /setup
prove: local → mod-log / deletion-log / honeypot / contact / apply channels exist under the logs category; if applications enabled, a Member role exists AND `@everyone` VIEW_CHANNELS is denied with the Member role granted — created in that order (channels first). DB: guild settings persisted (guild row + relevant config tables).
       uat   → channels + roles present and consistent; no "locked out" state.
pass:  setup provisions resources in safe order; no guild left view-denied without a member role.

### A2 honeypot setup
do:    run the honeypot setup command for a channel
prove: local → `honeypot_config` has `(guild_id, channel_id)`; re-running is idempotent (ON CONFLICT DO NOTHING); warning message posted to the channel.
       uat   → honeypot channel shows the warning post.
pass:  honeypot configured, idempotent on re-run. (Enforcement is covered in spam.md Batch D.)

### A3 tickets setup
do:    run the tickets-channel command; then a user opens a ticket via the button
prove: local → `tickets_config` row keyed by `message_id`; clicking the button opens a private thread named "<user> – <date>"; close buttons offer neutral/👍/👎.
       uat   → ticket thread created on button click.
pass:  ticket button provisions a private thread; close flow present.

### A4 reactji setup
do:    run setup-reactji-channel with an emoji + threshold
prove: local → `reactji_channeler_config` upserts `(guild_id, emoji)` with `channel_id`/`threshold`; re-running with a new threshold updates the row.
       uat   → config takes effect (forwarding tested in logging.md Batch D).
pass:  reactji config created/updated by (guild, emoji).

---

## Batch B — escalation (escalate → vote → resolve)
Prereq: `escalate` flag enabled for the guild. From a report thread, escalate a
user; cast votes from a couple of accounts; confirm tally + resolution.

DB:
```sh
sqlite3 ./mod-bot.sqlite3 "SELECT id,reported_user_id,voting_strategy,scheduled_for,resolution,resolved_at FROM escalations WHERE guild_id='<GUILD>' ORDER BY created_at DESC LIMIT 5;"
sqlite3 ./mod-bot.sqlite3 "SELECT escalation_id,voter_id,vote FROM escalation_records ORDER BY voted_at DESC LIMIT 10;"
```

### B1 create + vote
do:    escalate a user, then vote from 2 accounts
prove: local → grep `"Created escalation"` then `"Vote recorded"` (with `totalVotes`,`leader`); `escalations` row + one `escalation_records` row per voter; vote message shows the tally; `scheduled_for` shrinks as votes arrive (`36 - 4*voteCount` h).
       uat   → vote message updates with tally.
pass:  escalation + votes recorded; tally and schedule update.

### B2 vote toggle
do:    click the same resolution again from one voter
prove: local → grep `"Deleted existing vote"`; that voter's `escalation_records` row is removed.
       uat   → tally decrements for that voter.
pass:  re-clicking a resolution removes that vote.

### B3 resolution
do:    let it auto-resolve (or expedite), or test user-gone path by having the target leave
prove: local → grep `"Auto-resolving escalation"` (or `"Resolving escalation - user gone"` → resolves as track); `escalations.resolved_at`/`resolution` set; ties broken by most-severe.
       uat   → resolution action applied + posted.
pass:  resolves to the winning resolution (track if user gone / no winner).

---

## Batch C — member applications
Prereq: `member-applications` flag enabled + gate activated. From a fresh account,
click apply, fill the modal, then approve from staff; repeat and deny another.

DB:
```sh
sqlite3 ./mod-bot.sqlite3 "SELECT user_id,status,reviewed_by,resolved_at FROM applications WHERE guild_id='<GUILD>' ORDER BY created_at DESC LIMIT 5;"
```

### C1 apply → approve
do:    submit application, staff approves
prove: local → `applications` row pending → approved (`reviewed_by`,`resolved_at` set); applicant gets the member role + DM; mod-log updated.
       uat   → approval grants role + DM.
pass:  approval grants access and records reviewer.

### C2 apply → deny
do:    submit another, staff denies
prove: local → row → denied; applicant DM'd and kicked.
       uat   → denial DMs + removes applicant.
pass:  denial DMs and removes.

### C3 one-pending limit + auto-deny on leave
do:    try a second pending app from the same user; separately, have a pending applicant leave
prove: local → second submission blocked (one pending allowed); a departing pending applicant's row flips to denied (GuildMemberRemove handler).
       uat   → second app blocked; departure resolves the app.
pass:  single-pending enforced; departure auto-resolves.

---

## Batch D — single-shot commands
### D1 force-ban
do:    use the Force Ban user context command (needs Moderate Members)
prove: local → grep `"Force ban command executed"` then `"User force banned successfully"`; user banned; ephemeral confirm. No DB row (audit-log only).
       uat   → user banned, confirm shown.
pass:  force-ban bans and confirms.

### D2 modreport
do:    run /modreport on a user with history (needs Manage Messages)
prove: local → grep `"Modreport command executed"`; embed summarizes report count / channels / mod actions / 6-month sparkline. Read-only (no writes).
       uat   → embed renders with history.
pass:  modreport renders an accurate read-only summary.

### D3 track
do:    use the Track message context command (needs Manage Messages); then use the delete button
prove: local → `reported_messages` row with `reason='track'` + a user thread; reply "Tracked <#thread>"; clicking delete removes the original message and sets `deleted_at` on the row (row kept).
       uat   → thread created; delete removes message.
pass:  track logs to a thread; delete marks (not removes) the row.
