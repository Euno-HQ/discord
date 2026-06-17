# Passive pipelines: mod-action logger, deletion logger, activity tracker, reactji

Grounding: `app/commands/report/modActionLogger.ts` + `modActionLog.ts`,
`app/discord/pipelines/deletionLogHandlers.ts`,
`app/discord/pipelines/activityTrackerHandlers.ts`,
`app/discord/pipelines/reactjiChannelerHandler.ts`.
Tables: `mod_actions`, `message_cache`, `message_stats`, `reactji_channeler_config`.

---

## Batch A — mod-action logger (ban / unban / kick / timeout)
From a staff account, perform a **manual** ban, then unban, then kick, then
timeout against a throwaway test member. Ping me.

DB:
```sh
sqlite3 ./mod-bot.sqlite3 "SELECT action_type,executor_username,reason,duration,created_at FROM mod_actions WHERE user_id='<USER>' AND guild_id='<GUILD>' ORDER BY created_at DESC;"
```

### A1 each action logs + posts + persists
do:    manual ban, unban, kick, timeout
prove: local → grep `'"service":"ModActionLogger"'` for `"Ban detected"`/`"Unban detected"`/`"Member removal detected"`/`"Timeout detected"`; mod-log channel shows one post per action; DB has one `mod_actions` row per action with the right `action_type` (timeout row also has `duration`).
       uat   → log line + mod-log post per action.
pass:  4 actions → 4 logs + 4 posts (+ rows locally). Self-actions by the bot are intentionally skipped (debug "Skipping self-…").

### A2 one handler failure doesn't kill the pipeline
do:    (observe across the batch) after any single action that errors, perform another normal action
prove: local → the subsequent action still logs/persists — pipeline keeps consuming.
       uat   → subsequent action still posts.
pass:  a failure in one event doesn't stop later events.

---

## Batch B — deletion logger (cached vs uncached)
Post a fresh message, then delete it (cached). Then delete an **old** message the
bot never cached (uncached). Ping me.

DB (cache is written on message create):
```sh
sqlite3 ./mod-bot.sqlite3 "SELECT message_id,user_id,content IS NOT NULL AS has_content,last_touched FROM message_cache WHERE guild_id='<GUILD>' ORDER BY last_touched DESC LIMIT 5;"
```

### B1 cached delete → content present
do:    delete a recently-posted (cached) message
prove: local → grep `'"service":"DeletionLogger"'` + `'"message":"MessageDelete event data"'` with `"hasCacheEntry":true`; deletion-log post quotes the message content; `message_cache` had the row.
       uat   → deletion-log post includes the content.
pass:  cached deletion logs with content.

### B2 uncached delete → batched, content unknown
do:    delete an old/uncached message
prove: local → same event log with `"hasCacheEntry":false`; deletion-log shows a batched "N uncached message(s) deleted from #channel … we don't know the content or author" (batches within ~10s per channel).
       uat   → uncached batch post present, no content.
pass:  uncached deletion logs as count-only batch, no content claimed.

---

## Batch C — activity tracker (analytics)
Prereq: the `analytics` flag must be **enabled** for the guild (else this pipeline
no-ops with no logs — see flags-and-web.md). From a fresh account, post a message,
edit it, add a reaction, remove it, delete it.

DB:
```sh
sqlite3 ./mod-bot.sqlite3 "SELECT message_id,char_count,word_count,react_count FROM message_stats WHERE guild_id='<GUILD>' ORDER BY sent_at DESC LIMIT 5;"
```

### C1 message lifecycle writes stats
do:    post → edit → react → unreact → delete
prove: local → debug logs `"Message stats stored"` / `"…updated"` / `"…deleted"` (service ActivityTracker); DB row appears on post with `char_count`/`word_count`, `react_count` increments on react and decrements on unreact, row is removed on delete.
       uat   → the debug logs appear in order (no DB).
pass:  stats row tracks the message's lifecycle; react_count moves with reactions.

### C2 gated off when flag disabled
do:    (only if confirming the gate) disable `analytics`, repeat a post
prove: local → no ActivityTracker logs, no new `message_stats` row.
       uat   → no ActivityTracker logs.
pass:  disabled flag → silent no-op.

---

## Batch D — reactji channeler
Prereq: a reactji config exists (see setup in commands.md). React to a message
with the configured emoji until the threshold count is hit.

### D1 threshold reaction forwards
do:    add the configured emoji reactions up to the exact threshold
prove: local → grep `'"service":"ReactjiChanneler"'` + `"Forwarding message"` then `"Message forwarded successfully"`; the target channel receives the forwarded message plus a "Forwarded by @… reacting with <emoji>" summary.
       uat   → forward + summary appear in the target channel.
pass:  hitting the exact threshold forwards once with the reactor summary. (Trigger is `count === threshold`, so it fires exactly once.)
