# Event-bus / gateway resilience (#334 / #360)

Grounding: `app/discord/gateway.ts`, `app/discord/eventBus.ts`, `app/server.ts`
(`:206-229`). Pipelines are forked with `Effect.forkDaemon` so they outlive the
startup effect; the event bus is a process-lifetime `Queue` that buffers across a
gateway reconnect. This is a resilience check, mostly observed in logs.

Pipeline startup marker: grep `'"service":"Server"'` for the fork log
(`"Interrupted old pipeline fibers"` precedes a fresh fork on reload).

---

## Batch A — survives reconnect / restart
Trigger a gateway reconnect or a pod restart, then post a message that should drive
a pipeline (e.g. a deletion or a normal message). Ping me.

- **local:** restarting isn't ideal (dev hot-reloads); prefer forcing a reconnect,
  or accept a deliberate dev-server restart if you must. After it's back, act.
- **uat:** `kubectl -n staging rollout restart statefulset mod-bot-uat` (or wait for
  a natural reconnect), then act once the pod is Ready.

### A1 reconnect logged
do:    cause reconnect / restart
prove: local → grep `'"service":"Gateway"'` + `"Client reconnecting"` (or a fresh "Interrupted old pipeline fibers" on restart).
       uat   → same Gateway reconnect log.
pass:  reconnect/restart is logged.

### A2 pipelines still consume afterward
do:    after reconnect, post a normal message and delete a cached message
prove: local → after the reconnect timestamp, grep shows fresh `'"service":"Automod"'` `"Message evaluated"` AND `'"service":"DeletionLogger"'` `"MessageDelete event data"` — i.e. events still flow through the same queue to the daemon pipelines.
       uat   → same post-reconnect pipeline activity in logs.
pass:  pipelines produce activity *after* the reconnect — they survived it.

### A3 no duplicate/stuck fibers on reload (local only)
do:    (local) make a trivial code edit to force HMR, then post a message
prove: local → exactly one "Interrupted old pipeline fibers" + one fresh fork per reload; a single posted message yields a single "Message evaluated" (not N duplicates from leaked fibers).
pass:  reload interrupts old fibers and forks once; no duplicate processing.
