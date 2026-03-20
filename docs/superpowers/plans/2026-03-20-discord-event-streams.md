# Discord Event Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap Discord.js gateway events in Effect Streams with queue-based decoupling, then migrate the deletion logger as the first pipeline consumer.

**Architecture:** A `DiscordEventBus` Effect Layer pushes enriched domain events into a bounded sliding Queue, exposed as a `broadcastDynamic` Stream. Consumer pipelines subscribe to the broadcast, run as forked Fibers, and are interrupted/reforked on HMR reload. The deletion logger is the first pipeline, replacing 4 `client.on()` registrations with a single stream pipeline.

**Tech Stack:** Effect-TS (Stream, Queue, Sink, Schedule, Layer), Discord.js, Vite HMR

**Spec:** `docs/superpowers/specs/2026-03-20-discord-event-streams-design.md`

**Consult:** `@notes/EFFECT.md` for Effect patterns, `@notes/EFFECT_ADVANCED.md` for Stream/Queue/Schedule APIs.

---

### Task 1: Domain Event Types and Type Guards

Define the discriminated union of domain events and type guard helpers.

**Files:**
- Create: `app/discord/events.ts`
- Test: `app/discord/events.test.ts`

- [ ] **Step 1: Write tests for type guards**

```typescript
// app/discord/events.test.ts
import { describe, expect, test } from "vitest";
import {
  isGuildMessageEvent,
  type GuildMemberMessage,
  type GuildMessageDelete,
  type GuildMessageBulkDelete,
  type InteractionCreateEvent,
} from "./events";

describe("isGuildMessageEvent", () => {
  test("returns true for GuildMemberMessage", () => {
    const event = { type: "GuildMemberMessage" } as GuildMemberMessage;
    expect(isGuildMessageEvent(event)).toBe(true);
  });

  test("returns true for GuildMessageDelete", () => {
    const event = { type: "GuildMessageDelete" } as GuildMessageDelete;
    expect(isGuildMessageEvent(event)).toBe(true);
  });

  test("returns false for InteractionCreate", () => {
    const event = { type: "InteractionCreate" } as InteractionCreateEvent;
    expect(isGuildMessageEvent(event)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/discord/events.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement domain event types**

```typescript
// app/discord/events.ts
import type {
  AutoModerationActionExecution,
  Collection,
  Guild,
  GuildBan,
  GuildMember,
  GuildTextBasedChannel,
  Interaction,
  Message,
  MessageReaction,
  PartialGuildMember,
  PartialMessage,
  PartialMessageReaction,
  PartialUser,
  ThreadChannel,
  User,
} from "discord.js";

// --- Enriched message events ---
// Bot/system/DM messages are filtered at the source.
// MessageCreate gets full enrichment (guild + member available synchronously
// from Discord.js). Delete/Update/BulkDelete get guild resolved from client
// cache; pipelines handle further async resolution (e.g., message cache lookup).

export interface GuildMemberMessage {
  readonly type: "GuildMemberMessage";
  readonly message: Message<true>;
  readonly guild: Guild;
  readonly member: GuildMember;
}

export interface GuildMessageDelete {
  readonly type: "GuildMessageDelete";
  readonly message: Message | PartialMessage;
  readonly guild: Guild;
  readonly guildId: string;
}

export interface GuildMessageUpdate {
  readonly type: "GuildMessageUpdate";
  readonly oldMessage: Message | PartialMessage;
  readonly newMessage: Message | PartialMessage;
  readonly guild: Guild;
  readonly guildId: string;
}

export interface GuildMessageBulkDelete {
  readonly type: "GuildMessageBulkDelete";
  readonly messages: Collection<string, Message | PartialMessage>;
  readonly channel: GuildTextBasedChannel;
  readonly guild: Guild;
  readonly guildId: string;
}

// --- Raw events (not enriched, passed through as-is) ---

export interface InteractionCreateEvent {
  readonly type: "InteractionCreate";
  readonly interaction: Interaction;
}

export interface GuildBanAddEvent {
  readonly type: "GuildBanAdd";
  readonly ban: GuildBan;
}

export interface GuildBanRemoveEvent {
  readonly type: "GuildBanRemove";
  readonly ban: GuildBan;
}

export interface GuildMemberRemoveEvent {
  readonly type: "GuildMemberRemove";
  readonly member: GuildMember | PartialGuildMember;
}

export interface GuildMemberUpdateEvent {
  readonly type: "GuildMemberUpdate";
  readonly oldMember: GuildMember | PartialGuildMember;
  readonly newMember: GuildMember;
}

export interface GuildCreateEvent {
  readonly type: "GuildCreate";
  readonly guild: Guild;
}

export interface GuildDeleteEvent {
  readonly type: "GuildDelete";
  readonly guild: Guild;
}

export interface AutoModerationActionEvent {
  readonly type: "AutoModerationActionExecution";
  readonly execution: AutoModerationActionExecution;
}

export interface MessageReactionAddEvent {
  readonly type: "MessageReactionAdd";
  readonly reaction: MessageReaction | PartialMessageReaction;
  readonly user: User | PartialUser;
}

export interface MessageReactionRemoveEvent {
  readonly type: "MessageReactionRemove";
  readonly reaction: MessageReaction | PartialMessageReaction;
  readonly user: User | PartialUser;
}

export interface ThreadCreateEvent {
  readonly type: "ThreadCreate";
  readonly thread: ThreadChannel;
}

// --- Union type ---

export type GuildMessageEvent =
  | GuildMemberMessage
  | GuildMessageDelete
  | GuildMessageUpdate
  | GuildMessageBulkDelete;

export type DiscordEvent =
  | GuildMessageEvent
  | InteractionCreateEvent
  | GuildBanAddEvent
  | GuildBanRemoveEvent
  | GuildMemberRemoveEvent
  | GuildMemberUpdateEvent
  | GuildCreateEvent
  | GuildDeleteEvent
  | AutoModerationActionEvent
  | MessageReactionAddEvent
  | MessageReactionRemoveEvent
  | ThreadCreateEvent;

// --- Type guards ---

const GUILD_MESSAGE_TYPES = new Set([
  "GuildMemberMessage",
  "GuildMessageDelete",
  "GuildMessageUpdate",
  "GuildMessageBulkDelete",
]);

export const isGuildMessageEvent = (
  event: DiscordEvent,
): event is GuildMessageEvent => GUILD_MESSAGE_TYPES.has(event.type);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/discord/events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/discord/events.ts app/discord/events.test.ts
git commit -m "feat: add Discord domain event types and type guards"
```

---

### Task 2: DiscordEventBus Service and Layer

Create the Effect service that owns the queue and broadcast stream.

**Files:**
- Create: `app/discord/eventBus.ts`
- Modify: `app/AppRuntime.ts:27-34` (add to AppLayer)

**Note:** `Stream.broadcastDynamic` requires a `Scope`, so use `Layer.scoped`.
The Discord client is a module-level singleton imported from
`#~/discord/client.server`. This is the same pattern `gateway.ts` uses. The
queue uses `Queue.sliding` so `client.on()` callbacks never block.

- [ ] **Step 1: Create the DiscordEventBus service**

```typescript
// app/discord/eventBus.ts
import { Events, type GuildTextBasedChannel } from "discord.js";
import { Context, Effect, Layer, Queue, Stream } from "effect";

import { client } from "#~/discord/client.server";
import type { DiscordEvent } from "#~/discord/events";
import { log } from "#~/helpers/observability";

export interface IDiscordEventBus {
  readonly stream: Stream.Stream<DiscordEvent>;
}

export class DiscordEventBus extends Context.Tag("DiscordEventBus")<
  DiscordEventBus,
  IDiscordEventBus
>() {}

export const DiscordEventBusLive = Layer.scoped(
  DiscordEventBus,
  Effect.gen(function* () {
    const queue = yield* Queue.sliding<DiscordEvent>(1024);

    // --- Register event sources ---
    // These run once at Layer construction. The callbacks close over the queue
    // and push events with Effect.runFork (fire-and-forget, non-blocking).

    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot || message.author.system || !message.inGuild())
        return;
      if (!message.member) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMemberMessage",
          message,
          guild: message.guild,
          member: message.member,
        }),
      );
    });

    client.on(Events.MessageDelete, (message) => {
      if (message.system || message.author?.bot || !message.guildId) return;
      const guild = client.guilds.cache.get(message.guildId);
      if (!guild) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMessageDelete",
          message,
          guild,
          guildId: message.guildId,
        }),
      );
    });

    client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
      if (
        !newMessage.guildId ||
        newMessage.author?.bot ||
        newMessage.author?.system
      )
        return;
      if (oldMessage.content === newMessage.content) return;
      const guild = client.guilds.cache.get(newMessage.guildId);
      if (!guild) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMessageUpdate",
          oldMessage,
          newMessage,
          guild,
          guildId: newMessage.guildId,
        }),
      );
    });

    client.on(Events.MessageBulkDelete, (messages, channel) => {
      const guildId = messages.first()?.guildId ?? channel.guildId;
      if (!guildId) return;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMessageBulkDelete",
          messages,
          channel: channel as GuildTextBasedChannel,
          guild,
          guildId,
        }),
      );
    });

    // TODO: Add remaining event types as handlers are migrated to pipelines.
    // For now, only message events are queued (deletion logger is first consumer).

    log("info", "DiscordEventBus", "Event source registered");

    // Create broadcast stream — each subscriber gets independent backpressure.
    // The Scope from Layer.scoped keeps the broadcast alive for the runtime lifetime.
    const stream = yield* Stream.broadcastDynamic(
      Stream.fromQueue(queue),
      1024,
    );

    return { stream };
  }),
);
```

- [ ] **Step 2: Add DiscordEventBusLive to AppLayer**

In `app/AppRuntime.ts`, add the import and include in `Layer.mergeAll`:

```typescript
// Add import:
import { DiscordEventBusLive } from "#~/discord/eventBus";

// Update AppLayer:
const AppLayer = Layer.mergeAll(
  DatabaseLayer,
  PostHogServiceLive,
  FeatureFlagServiceLive,
  Layer.provide(SpamDetectionServiceLive, DatabaseLayer),
  MessageCacheServiceLive,
  DiscordEventBusLive,
  InfraLayer,
);
```

- [ ] **Step 3: Verify type check passes**

Run: `npx tsc --noEmit 2>&1 | grep -v "+types\|virtual:react-router"`
Expected: No new errors (pre-existing route type errors are OK)

- [ ] **Step 4: Commit**

```bash
git add app/discord/eventBus.ts app/AppRuntime.ts
git commit -m "feat: add DiscordEventBus Layer with queue and broadcast stream"
```

---

### Task 3: Extract Deletion Logger Handler Functions

Pull the Effect business logic out of the `client.on()` closures in
`deletionLogger.ts` into standalone, testable functions. The existing logic
doesn't change — we're just moving it out of closures.

**Files:**
- Create: `app/discord/pipelines/deletionLogHandlers.ts`
- Reference: `app/discord/deletionLogger.ts:110-490` (existing handler logic)

Each handler receives a domain event (from Task 1) and returns an
`Effect<void, never, RuntimeContext>`. Error handling is per-handler via
`catchAll`, matching the current pattern.

- [ ] **Step 1: Create handler file with handleDelete**

Extract the MessageDelete handler logic from `deletionLogger.ts:110-282` into
a standalone function. The function receives a `GuildMessageDelete` event and
the Discord client (needed for audit log + user resolution).

```typescript
// app/discord/pipelines/deletionLogHandlers.ts
import { AuditLogEvent, Colors, type Client } from "discord.js";
import { Effect } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { AUDIT_LOG_WINDOW_MS, fetchAuditLogEntry } from "#~/discord/auditLog";
import type {
  GuildMessageBulkDelete,
  GuildMessageDelete,
  GuildMessageUpdate,
} from "#~/discord/events";
import {
  fetchChannel,
  fetchUserOrNull,
} from "#~/effects/discordSdk";
import { logEffect } from "#~/effects/observability";
import { quoteMessageContent } from "#~/helpers/discord";
import { MessageCacheService } from "#~/discord/messageCacheService";
import { getOrCreateDeletionLogThread } from "#~/models/deletionLogThreads";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";
import { getOrCreateUserThread } from "#~/models/userThreads";
```

The actual handler functions are direct extractions of the existing Effect.gen
blocks from `deletionLogger.ts`. Copy the logic from the `client.on()` closures
with these changes:

- Replace `msg` parameter with the typed domain event (`e.message`, `e.guild`, etc.)
- Replace `client` from closure with explicit parameter
- Remove the outer `runGatedFeature` wrapper (feature gating moves to the pipeline)
- Keep all `Effect.catchAll`, `Effect.withSpan`, and `logEffect` calls as-is

Also copy the uncached deletion batching state that `handleDelete` depends on:
- `UncachedBatch` interface
- `UNCACHED_BATCH_WINDOW_MS` constant
- `uncachedBatches` Map
- `flushUncachedBatch` function

These all move from `deletionLogger.ts` into `deletionLogHandlers.ts`.

Create these functions:
- `handleDelete(client: Client, e: GuildMessageDelete): Effect<void, never, RuntimeContext>`
- `handleEdit(client: Client, e: GuildMessageUpdate): Effect<void, never, RuntimeContext>`
- `handleBulkDelete(client: Client, e: GuildMessageBulkDelete): Effect<void, never, RuntimeContext>`

**Important:** These are mechanical extractions. Do NOT refactor the business
logic — preserve it exactly. The stream migration is about changing the plumbing,
not the handlers.

- [ ] **Step 2: Verify type check passes**

Run: `npx tsc --noEmit 2>&1 | grep -v "+types\|virtual:react-router"`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add app/discord/pipelines/deletionLogHandlers.ts
git commit -m "feat: extract deletion logger handler functions from closures"
```

---

### Task 4: Deletion Logger Pipeline

Build the Stream pipeline that replaces `startDeletionLogging`.

**Files:**
- Create: `app/discord/pipelines/deletionLogger.ts`
- Reference: `app/discord/deletionLogger.ts` (existing implementation)
- Reference: `app/discord/events.ts` (domain types from Task 1)
- Reference: `app/discord/eventBus.ts` (event bus from Task 2)

- [ ] **Step 1: Write the pipeline**

```typescript
// app/discord/pipelines/deletionLogger.ts
import { Effect, Schedule, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { client } from "#~/discord/client.server";
import { DiscordEventBus } from "#~/discord/eventBus";
import { isGuildMessageEvent } from "#~/discord/events";
import { MessageCacheService } from "#~/discord/messageCacheService";
import {
  FeatureFlagService,
} from "#~/effects/featureFlags";
import { logEffect } from "#~/effects/observability";

import {
  handleBulkDelete,
  handleDelete,
  handleEdit,
} from "./deletionLogHandlers";

export const deletionLoggerPipeline: Effect.Effect<
  void,
  never,
  RuntimeContext
> = Effect.gen(function* () {
  const { stream } = yield* DiscordEventBus;
  const cache = yield* MessageCacheService;
  const flags = yield* FeatureFlagService;

  yield* stream.pipe(
    Stream.filter(isGuildMessageEvent),

    // Feature flag gate — skip events for guilds without deletion-log enabled.
    // All GuildMessageEvent variants carry `guild: Guild`, so `e.guild.id` is
    // always available.
    Stream.filterEffect((e) =>
      flags
        .isPostHogEnabled("deletion-log", e.guild.id)
        .pipe(Effect.catchAll(() => Effect.succeed(false))),
    ),

    // Cache messages on the way through
    Stream.tap((e) => {
      switch (e.type) {
        case "GuildMemberMessage":
          return cache.upsertMessage({
            messageId: e.message.id,
            guildId: e.guild.id,
            channelId: e.message.channelId,
            userId: e.member.id,
            content: e.message.content,
          });
        case "GuildMessageUpdate":
          return cache.touchMessage(
            e.newMessage.id,
            e.newMessage.content ?? null,
          );
        default:
          return Effect.void;
      }
    }),

    // Dispatch to handlers with per-event error isolation
    Stream.mapEffect((e) => {
      const handler = (() => {
        switch (e.type) {
          case "GuildMemberMessage":
            return Effect.void;
          case "GuildMessageDelete":
            return handleDelete(client, e);
          case "GuildMessageUpdate":
            return handleEdit(client, e);
          case "GuildMessageBulkDelete":
            return handleBulkDelete(client, e);
        }
      })();
      return handler.pipe(
        Effect.catchAll((err) =>
          logEffect("warn", "DeletionLogger", "Pipeline handler failed", {
            eventType: e.type,
            error: String(err),
          }),
        ),
      );
    }),

    Stream.runDrain,
  );
});
```

**Note on uncached deletion batching:** The first pass uses the existing
per-event handling from `handleDelete` (which includes the uncached batching
via `setTimeout`/`Map`). Migrating that to `Stream.aggregateWithin` is a
follow-up optimization — get the pipeline working first, then refine the
batching.

- [ ] **Step 2: Verify type check passes**

Run: `npx tsc --noEmit 2>&1 | grep -v "+types\|virtual:react-router"`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add app/discord/pipelines/deletionLogger.ts
git commit -m "feat: add deletion logger stream pipeline"
```

---

### Task 5: Pipeline Lifecycle in server.ts

Wire up the pipeline forking/interrupting in the startup Effect. Remove the
old `startDeletionLogging` call.

**Files:**
- Modify: `app/server.ts:81-177` (startup Effect)

- [ ] **Step 1: Add imports and globalThis declaration**

Add to the imports in `server.ts`:

```typescript
import { Fiber } from "effect";
import { deletionLoggerPipeline } from "#~/discord/pipelines/deletionLogger";
```

Add the globalThis declaration (near the existing `__discordOneTimeSetupDone`):

```typescript
declare global {
  var __pipelineFibers: Fiber.RuntimeFiber<void, never>[] | undefined;
}
```

- [ ] **Step 2: Add pipeline fork/interrupt to startup Effect**

After the one-time setup block, add the pipeline lifecycle code. This runs on
every reload — interrupts old fibers, forks new ones with fresh handler code:

```typescript
  // Pipeline (re)start — runs every reload for HMR support.
  // Interrupt stale fibers, fork fresh pipelines with updated handler code.
  // The event bus queue buffers events during the brief swap.
  if (globalThis.__pipelineFibers) {
    yield* Effect.all(
      globalThis.__pipelineFibers.map((f) => Fiber.interrupt(f)),
    );
    yield* logEffect("info", "Server", "Interrupted old pipeline fibers");
  }
  globalThis.__pipelineFibers = [
    yield* deletionLoggerPipeline.pipe(Effect.fork),
  ];
  yield* logEffect("info", "Server", "Pipeline fibers forked");
```

- [ ] **Step 3: Remove startDeletionLogging from one-time setup**

In the `Promise.allSettled` block inside `if (!globalThis.__discordOneTimeSetupDone)`,
remove the `startDeletionLogging(discordClient)` call. Also remove its import
at the top of the file.

The `startMessageCacheExpiration` call that was inside `startDeletionLogging`
needs to move. Add it to the one-time setup block as a standalone call:

```typescript
// Inside the one-time setup block, after the Promise.allSettled:
startMessageCacheExpiration(() =>
  runEffect(
    Effect.gen(function* () {
      const cache = yield* MessageCacheService;
      yield* cache.expireContent();
      yield* cache.expireRows();
    }).pipe(
      Effect.catchAll((e) =>
        logEffect("warn", "MessageCacheExpiration", "Expiration run failed", {
          error: String(e),
        }),
      ),
    ),
  ),
);
```

- [ ] **Step 4: Verify type check passes**

Run: `npx tsc --noEmit 2>&1 | grep -v "+types\|virtual:react-router"`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add app/server.ts
git commit -m "feat: wire up pipeline lifecycle with HMR fork/interrupt"
```

---

### Task 6: Manual Integration Test

Verify the pipeline works end-to-end and HMR reloads correctly.

**Files:**
- No file changes — this is a manual verification task.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Server starts, logs show:
- `"Event source registered"` (from DiscordEventBus Layer)
- `"Pipeline fibers forked"` (from server.ts)
- Gateway connects as before

- [ ] **Step 2: Verify deletion logging works**

In a test Discord server:
1. Send a message in a channel with deletion logging enabled
2. Delete the message
3. Verify the deletion is logged to the deletion log thread

Expected: Same behavior as before the migration.

- [ ] **Step 3: Verify HMR reloads the pipeline**

1. Edit a handler in `app/discord/pipelines/deletionLogHandlers.ts` (e.g., add
   a temporary `logEffect` call at the top of `handleDelete`)
2. Save the file
3. Watch the dev server output

Expected: Logs show:
- `"Server file changed: .../deletionLogHandlers.ts, reloading..."`
- `"Interrupted old pipeline fibers"`
- `"Pipeline fibers forked"`

4. Delete another message in Discord
5. Verify the new log line appears

Expected: The temporary `logEffect` fires, proving HMR picked up the change.

- [ ] **Step 4: Clean up and commit**

Remove the temporary `logEffect` added for testing.

```bash
git add -A
git commit -m "chore: verify pipeline HMR integration"
```

---

### Task 7: Clean Up Old Deletion Logger

Remove the old `startDeletionLogging` function now that the pipeline replaces it.

**Files:**
- Modify: `app/discord/deletionLogger.ts` — remove the old `startDeletionLogging`
  function and its `client.on()` registrations. Keep only imports/types needed
  by `deletionLogHandlers.ts` (if any). If nothing remains, delete the file.
- Modify: `app/server.ts` — verify `startDeletionLogging` import is fully removed

- [ ] **Step 1: Remove or gut deletionLogger.ts**

The `startDeletionLogging` function and all its `client.on()` handlers are now
replaced by the pipeline. The uncached batching state (`uncachedBatches` Map,
`flushUncachedBatch`, `UNCACHED_BATCH_WINDOW_MS`) should move to
`deletionLogHandlers.ts` if `handleDelete` still uses it (since we deferred
the `aggregateWithin` migration).

Check whether `deletionLogger.ts` exports anything else that other files import.
If not, delete it entirely and move the batching state to `deletionLogHandlers.ts`.

- [ ] **Step 2: Verify no broken imports**

Run: `npx tsc --noEmit 2>&1 | grep -v "+types\|virtual:react-router"`
Expected: No new errors

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass (none should reference the deleted code directly)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove old startDeletionLogging, replaced by stream pipeline"
```
