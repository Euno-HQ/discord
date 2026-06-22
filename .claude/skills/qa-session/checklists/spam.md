# Spam pipeline (#359 / #361 / #308 / #353)

Grounding: `app/features/spam/service.ts`, `app/features/spam/spamResponseHandler.ts`,
`app/models/reportedMessages.ts`, `app/discord/pipelines/automod.ts`,
`app/commands/report/userLog.ts`. Table: `reported_messages` (see `app/db.d.ts`).

DB note — every message that reaches a verdict ≥ low writes a `reported_messages`
row: key columns `reported_message_id`, `reported_user_id`, `guild_id`,
`reason` (`'spam'`), `extra` (verdict summary), `log_message_id`, `deleted_at`.
Unique index `idx_unique_message_reason_guild` on
`(reported_message_id, reason, guild_id)`; inserts use `ON CONFLICT DO NOTHING`.

Reusable local queries (swap IDs):
```sh
sqlite3 ./mod-bot.sqlite3 "SELECT reported_message_id,reason,extra,deleted_at,created_at FROM reported_messages WHERE reported_user_id='<USER>' AND guild_id='<GUILD>' ORDER BY created_at DESC LIMIT 10;"
```

---

## Batch A — burst spam (the happy path)
From a **fresh non-staff** account, post the same message 3+ times fast across two
channels, then ping me.

### A1 verdict reached
do:    (covered by Batch A actions)
prove: local → grep dev.log `'"service":"SpamResponse"'` + `'"message":"Spam verdict:'`; AND a row exists per query above with `extra` like `Score N (tier): …`
       uat   → `kubectl -n staging logs … | grep '"service":"SpamResponse"' | grep 'Spam verdict:'`
pass:  one verdict log with `tier` of medium/high and matching `score`; ≥1 `reported_messages` row.

### A2 enforcement chain
do:    (same burst)
prove: local → in Discord: offending messages gone from the channels; target is timed out; if ≥3 high-tier reports, target was softban+unbanned (mod-log reply "Automatically removed <@…> for spam (last hour of messages also deleted)"). DB: matching rows have `deleted_at` set after cleanup.
       uat   → mod-log channel shows the removal reply; logs show no `"Failed to delete spam message"` / `"Failed to timeout user"` / `"Failed to softban spammer"` (all `warn`, SpamResponse).
pass:  messages removed + timeout applied; no enforcement-failure warnings.

### A3 mod-thread report
do:    (same burst)
prove: local → a thread post appears in the mod-log area: header "detected as spam" with score/signal breakdown + a quoted copy of the message. DB row's `log_message_id`/`log_channel_id` are populated.
       uat   → mod thread post present with the score breakdown.
pass:  report posted with score/tier breakdown; `log_message_id` non-null.

### A4 back-fill summary (idempotent)
do:    (same burst — the earlier duplicates get back-filled)
prove: local → grep `'"message":"Back-fill complete:'` (SpamResponse, info) → `N new, M already recorded`; NO `"Failed to back-fill prior duplicate into reported_messages"` (warn).
       uat   → same greps on pod logs.
pass:  one "Back-fill complete" line with sane counts; zero back-fill failures.

---

## Batch B — repeat offender (the #361 collision path)
Wait out any cooldown, then trigger a **second** verdict for the **same** user
(another burst). Ping me.

### B1 no duplicate-insert failure
do:    (second verdict for same user)
prove: local → grep back-fill line again: prior messages now show as `already recorded`, not `new`; still zero `"Failed to back-fill…"` warnings. DB: no duplicate rows for the same `(reported_message_id,'spam',guild_id)`.
       uat   → back-fill line shows `already recorded` count > 0, no failure warnings.
pass:  collision handled silently as "already recorded"; if any failure *does* log, its context carries a structured sqlite `code`/`message` (not an opaque string).

---

## Batch C — forwarded-message spam
Forward the same message repeatedly from a fresh account (Discord "Forward").

### C1 forwarded content feeds the detector
do:    forward identical content several times
prove: local → verdict fires (as A1); the mod-thread report header notes "(forwarded)"; `getMessageContent` pulled the snapshot text (`app/helpers/discord.ts:309`).
       uat   → verdict log present; report shows forwarded note.
pass:  forwarded content is detected the same as inline content; report marks it forwarded.

---

## Batch D — honeypot
Post in the honeypot channel — **once from a non-staff account, once from a mod
account** (to confirm the exemption).

### D1 non-staff post → enforced
do:    non-staff posts in honeypot channel
prove: local → softban executed immediately (honeypot tier = 100); user removed.
       uat   → mod-log shows the honeypot removal.
pass:  immediate softban on the non-staff post.

### D2 mod post → exempt
do:    mod posts in honeypot channel
prove: local → grep `'"message":"Mod posted in honeypot channel, no action taken"'` (SpamDetection, debug); no enforcement.
       uat   → same log line; no removal.
pass:  mod post produces the exemption log and no action. (This is the "spam looks broken from a staff account" gotcha.)

---

## Batch E — non-spam control
From a fresh account, post a few normal, distinct messages.

### E1 no false positive
do:    post normal varied messages
prove: local → automod still evaluates them (`grep '"service":"Automod"' | grep '"message":"Message evaluated"'` shows `tier:"none"`), but NO "Spam verdict:" log and NO new `reported_messages` row for those message IDs.
       uat   → no "Spam verdict:" logs for the control messages.
pass:  pipeline saw the messages (tier none) and took no action; zero rows written.
