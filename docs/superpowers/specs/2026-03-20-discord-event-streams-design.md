# Discord Event Stream Architecture

## Problem

Discord.js event handlers are registered via `client.on()` callbacks during
startup. This causes two problems:

1. **HMR doesn't work for event handlers.** Each `client.on()` captures handler
   logic in a closure at registration time. When Vite reloads a handler file,
   the old closure still runs. Duplicate registrations compound on each reload.

2. **Stateful cross-event logic is ad-hoc.** Handlers that span multiple event
   types (e.g., deletion logging needs MessageCreate for caching + MessageDelete
   for logging) coordinate through module-level mutable state, manual timers,
   and shared Maps. This is fragile and hard to reason about.

## Design

### Event Source Layer

A new Effect Layer (`DiscordEventBusLive`) that:

- Is constructed once when the `ManagedRuntime` starts (Layer lifecycle replaces
  `globalThis` guards)
- Registers one `client.on()` per Discord event type
- Enriches raw Discord.js events into **domain events** before queuing — filters
  out bots, system messages, and DMs; resolves guild and member references. Every
  consumer receives pre-validated, richly-typed events.
- Pushes domain events into a bounded `Queue<DiscordEvent>` (capacity 1024,
  sliding strategy — if a consumer falls behind, oldest events are dropped
  rather than blocking the `client.on()` callback thread)
- Exposes a `Stream` via `Stream.broadcastDynamic` so pipelines can subscribe
  independently without the Layer needing to know the consumer count at
  construction time. Each subscription gets independent backpressure. The
  Layer's `Scope` (owned by `ManagedRuntime`) outlives all pipeline fibers.

**Bridging callback-land to Effect:** The `client.on()` callbacks are plain
JavaScript. The Layer constructs the queue in `Effect.gen`, then the callbacks
close over it and use `Effect.runFork(Queue.offer(queue, event))` to push
events without blocking the Discord.js event loop.

```
Discord.js client
  → client.on(MessageCreate)
    → filter bots/system/DMs, resolve member
    → runFork(Queue.offer(queue, { type: "GuildMemberMessage", ... }))
  → client.on(MessageDelete)
    → resolve guild, lookup cache
    → runFork(Queue.offer(queue, { type: "GuildMemberMessageDelete", ... }))
  → ...

Queue<DiscordEvent> (bounded 1024, sliding)
  → Stream.fromQueue(queue)
    → Stream.broadcastDynamic
      → pipeline 1 (deletionLogger)
      → pipeline 2 (automod, future)
      → pipeline 3 (activityTracker, future)
```

### Domain Event Types

Instead of passing raw Discord.js types, the event bus normalizes into domain
events that pipelines can consume without redundant checks:

```typescript
type DiscordEvent =
  // Enriched — bot/system/DM filtered, guild resolved from client cache.
  // MessageCreate gets full enrichment (member available sync from Discord.js).
  // Delete/Update/BulkDelete get guild only; cache lookup happens in pipelines.
  | { type: "GuildMemberMessage"; message: Message<true>; guild: Guild; member: GuildMember }
  | { type: "GuildMessageDelete"; message: Message | PartialMessage; guild: Guild; guildId: string }
  | { type: "GuildMessageUpdate"; oldMessage: Message | PartialMessage; newMessage: Message | PartialMessage; guild: Guild; guildId: string }
  | { type: "GuildMessageBulkDelete"; messages: Collection<...>; channel: GuildTextBasedChannel; guild: Guild; guildId: string }
  // Raw — don't need enrichment or aren't consumed by pipelines yet
  | { type: "InteractionCreate"; interaction: Interaction }
  | { type: "GuildBanAdd"; ban: GuildBan }
  | { type: "GuildBanRemove"; ban: GuildBan }
  | { type: "GuildMemberRemove"; member: GuildMember | PartialGuildMember }
  | { type: "GuildMemberUpdate"; oldMember: GuildMember | PartialGuildMember; newMember: GuildMember }
  | { type: "GuildCreate"; guild: Guild }
  | { type: "GuildDelete"; guild: Guild }
  | { type: "AutoModerationActionExecution"; execution: AutoModerationActionExecution }
  | { type: "MessageReactionAdd"; reaction: MessageReaction | PartialMessageReaction; user: User | PartialUser }
  | { type: "MessageReactionRemove"; reaction: MessageReaction | PartialMessageReaction; user: User | PartialUser }
  | { type: "ThreadCreate"; thread: ThreadChannel }
```

The boundary: enrichment at the source covers things **every consumer would
re-derive** (is it a guild message? who's the member?). Pipeline-specific
concerns (feature flags, guild settings) stay in the pipeline.

### Consumer Pipelines

Each pipeline is an `Effect<void>` that subscribes to the event bus, builds a
stream pipeline, and drains it. Pipelines live in `app/discord/pipelines/`.

Pipelines are started as forked Fibers. On HMR reload, `server.ts` interrupts
old fibers and forks new ones with fresh handler code. The queue buffers events
during the brief swap — no events are lost.

**HMR and in-flight events:** When a pipeline fiber is interrupted during an
in-flight handler (e.g., mid-Discord API call in `handleDelete`), Effect
cleanly interrupts it — no resource leaks. However, that specific event may be
silently dropped. For a deletion logger this is acceptable (a single missed log
entry on developer reload). Pipelines that cannot tolerate this would need
`Effect.uninterruptible` around critical sections.

```typescript
// In server.ts startup Effect:

// Command registration — runs every reload
yield* Effect.all([ registerCommand(setup), ... ]);

// Gateway init — Layer lifecycle, no globalThis needed
const discordClient = yield* initDiscordBot;

// One-time setup (non-pipeline handlers, until individually migrated)
if (!globalThis.__discordOneTimeSetupDone) { ... }

// Pipeline (re)start — runs every reload
if (globalThis.__pipelineFibers) {
  yield* Effect.all(globalThis.__pipelineFibers.map(Fiber.interrupt));
}
globalThis.__pipelineFibers = [
  yield* deletionLoggerPipeline.pipe(Effect.fork),
];
```

### First Migration: Deletion Logger Pipeline

The deletion logger is the proving ground because it exercises the most stream
features: cross-event state (caching), temporal batching (uncached deletions),
and multiple event types.

```typescript
export const deletionLoggerPipeline = Effect.gen(function* () {
  const { stream } = yield* DiscordEventBus;
  const cache = yield* MessageCacheService;

  yield* stream.pipe(
    // Narrow to guild message events
    Stream.filter(isGuildMessageEvent),

    // Pipeline-specific gate
    Stream.filterEffect((e) => isFeatureEnabled("deletion-log", e.guild.id)),

    // Cache on the way through
    Stream.tap((e) => {
      switch (e.type) {
        case "GuildMemberMessage": return cache.upsertMessage(e);
        case "GuildMemberMessageUpdate": return cache.touchMessage(e.newMessage.id, e.newMessage.content);
        default: return Effect.void;
      }
    }),

    // Dispatch to handlers — each wrapped in catchAll so a single handler
    // failure doesn't kill the pipeline. Mirrors the current per-event
    // error handling in deletionLogger.ts.
    Stream.mapEffect((e) => {
      const handler = (() => {
        switch (e.type) {
          case "GuildMemberMessage": return Effect.void;
          case "GuildMemberMessageDelete": return handleDelete(e);
          case "GuildMemberMessageUpdate": return handleEdit(e);
          case "GuildMessageBulkDelete": return handleBulkDelete(e);
        }
      })();
      return handler.pipe(
        Effect.catchAll((err) =>
          logEffect("warn", "DeletionLogger", "Handler failed", {
            eventType: e.type,
            error: String(err),
          })
        ),
      );
    }),

    Stream.runDrain,
  );
});
```

**Uncached deletion batching:** The current `setTimeout`/`Map`/`clearTimeout`
bookkeeping (40 lines) is replaced inside `handleDelete`. Uncached deletes
(where `e.cached` is null and the author is unknown) are routed to a sub-stream
that groups by `guild:channel` and batches within a 10-second window:

```typescript
// Inside handleDelete, uncached deletes branch to:
uncachedStream.pipe(
  Stream.groupByKey((e) => `${e.guild.id}:${e.message.channelId}`),
  Stream.flatMap((group) =>
    group.pipe(
      Stream.aggregateWithin(
        Sink.collectAll(),
        Schedule.fixed("10 seconds"),
      ),
      Stream.mapEffect(flushUncachedBatch),
    )
  ),
)
```

This is more structurally involved than a one-liner — it requires splitting the
delete handling into cached (immediate) and uncached (batched) branches. The
implementation will likely use `Stream.partition` or a conditional branch before
the `mapEffect` dispatch.

Handler functions (`handleDelete`, `handleEdit`, `handleBulkDelete`) are
essentially the existing Effect code extracted from the current `client.on()`
callbacks — business logic doesn't change.

Cache expiration moves to `Effect.repeat(Schedule.fixed("10 minutes"))` as a
separate forked fiber (preserving the existing 10-minute interval), not part of
the event stream.

### What Stays As-Is

**Stays on `client.on()` in gateway.ts (thin gateway concerns):**
- `InteractionCreate` — works via globalThis commands Map
- `ThreadCreate` — thin join + analytics
- `Events.Raw` — diagnostic logging
- `Events.Error`, `ShardDisconnect`, `ShardReconnecting` — gateway lifecycle

**Stays on `globalThis.__discordOneTimeSetupDone` guard (until migrated):**
- `automod.ts`
- `modActionLogger.ts`
- `activityTracker.ts`
- `reactjiChanneler.ts`
- `onboardGuild.ts`

### Migration Path Per Handler

To migrate any remaining handler to a pipeline:

1. Write the pipeline in `app/discord/pipelines/`
2. Add any new domain event types to the `DiscordEvent` union + event source
3. Add the pipeline to the fiber fork list in `server.ts`
4. Remove the old `client.on()` setup call from the one-time block

## Scope

**In scope (first pass):**
- `DiscordEventBusLive` Layer with queue, domain events, broadcast
- `deletionLoggerPipeline` as proving ground
- Pipeline lifecycle in `server.ts` (fork/interrupt on HMR)

**Out of scope (future work):**
- Migrating remaining handlers to pipelines
- Moving Discord client to a Layer (#320)
- Evaluating dfx (#321)

## Related Issues

- #318 — Create DiscordService Layer (event bus is a step toward this)
- #319 — Replace raw timers with Effect Schedule (deletion batching is first case)
- #320 — Migrate singletons to Layers (event bus establishes the pattern)
- #321 — Evaluate dfx (stream architecture would ease a future swap)
- #266 — Effect migration remaining files (gateway.ts is last phase)
