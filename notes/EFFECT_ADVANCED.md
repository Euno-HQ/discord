# Effect Advanced Patterns

Deeper reference for constructs beyond the day-to-day. Each section is tagged:

- **🟢 Core** — load-bearing in the codebase; the real usage is documented in
  [EFFECT.md](./EFFECT.md) / [EFFECT_REFERENCE.md](./EFFECT_REFERENCE.md) and this
  section is just extra background.
- **🟡 Used** — appears in a few places.
- **⚪ Not used yet** — documented for when we need it; no current call sites.

| Pattern | Status | Where it lives |
| --- | --- | --- |
| Stream processing | 🟢 Core | `app/discord/eventBus.ts`, `app/discord/pipelines/*` |
| Queues | 🟢 Core | the broadcast queue in `eventBus.ts` |
| Schedule combinators | 🟡 Used | `withRetry` (`errorHandling.ts`), 6h integrity repeat (`Database.ts`) |
| Ref | 🟡 Used | single-flight dedup (`models/userThreads.ts`), in-memory caches |
| Fiber supervision | 🟡 Used | `forkDaemon` pipelines + `SupervisorService` (`supervisor.ts`) |
| Sink | ⚪ Not used yet | — |
| Config module | ⚪ Not used yet | env read via `app/helpers/env.server.ts` instead |
| `acquireUseRelease` | ⚪ Not used yet | `Layer.scoped` + `acquireRelease` used at the Layer level instead |

## Stream Processing

🟢 **Core.** This is the bot's event-processing backbone. The walkthrough below
is background; for the actual pipeline pattern you should copy, see EFFECT.md →
"Event Pipelines (Streams)".

For large or potentially infinite data pipelines:

```typescript
import { Stream, Sink } from "effect";

// Create from array
const stream = Stream.fromIterable(items);

// Process with effects
const processed = stream.pipe(
  Stream.mapEffect(processItem),
  Stream.buffer(100), // Backpressure control
  Stream.run(Sink.collectAll()),
);
```

### Stream Sources

| Data Source     | Create With                 | Process With                       |
| --------------- | --------------------------- | ---------------------------------- |
| Array           | `Stream.fromIterable`       | `Stream.map`, `Stream.filter`      |
| Async iterator  | `Stream.fromAsyncIterable`  | `Stream.mapEffect`                 |
| Events          | `Stream.async`              | `Stream.buffer`, `Stream.debounce` |
| Intervals       | `Stream.repeatEffect`       | `Stream.take`, `Stream.takeWhile`  |
| File lines      | `Stream.fromReadableStream` | `Stream.transduce`                 |

**In this codebase:** The `DiscordEventBus` Layer (`app/discord/eventBus.ts`)
uses `Stream.fromQueue` and `Stream.broadcastDynamic` to distribute Discord
events to consumer pipelines. The deletion logger pipeline
(`app/discord/pipelines/deletionLogger.ts`) uses `Stream.filter`,
`Stream.filterEffect`, `Stream.tap`, `Stream.mapEffect`, and `Stream.runDrain`
to process events. See the design spec at
`docs/superpowers/specs/2026-03-20-discord-event-streams-design.md`.

### When to Consider Streams

- Processing more than ~1000 items
- Real-time event processing
- Data that arrives over time (not all at once)
- Need backpressure control
- Replacing `client.on()` event handlers with hot-swappable pipelines (HMR)

## Sink Patterns

⚪ **Not used yet.** Our pipelines all terminate in `Stream.runDrain` (process
forever, discard output). Custom `Sink` accumulation would only matter if we
needed to collect/fold a finite stream — documented here for that day.

Custom accumulation logic for Streams:

```typescript
import { Sink } from "effect";

// Collect all results
const collectAll = Sink.collectAll();

// Custom fold with stop condition
const customSink = Sink.fold(
  0,                          // Initial state
  (sum, n) => sum < 100,      // Continue condition
  (sum, n) => sum + n,        // Accumulator
);
```

## Schedule Combinators

🟡 **Used.** Our retry policy `withRetry` (`app/effects/errorHandling.ts`) is
`Schedule.exponential("200 millis", 2) |> jittered |> compose(recurs(3))`, and
`Database.ts` repeats the integrity check on `Schedule.fixed("6 hours")`. More
combinators, for reference:

| Pattern             | Schedule                             | Use Case                    |
| ------------------- | ------------------------------------ | --------------------------- |
| Fixed delay         | `Schedule.fixed("1 second")`         | Polling, heartbeats         |
| Exponential backoff | `Schedule.exponential("100 millis")` | Retry with increasing delay |
| Limited attempts    | `Schedule.recurs(5)`                 | Max retry count             |
| Fibonacci delays    | `Schedule.fibonacci("100 millis")`   | Gradual backoff             |
| Cron-like           | `Schedule.cron("0 */15 * * * *")`    | Scheduled tasks             |
| Jittered            | `Schedule.jittered()`                | Avoid thundering herd       |

### Combining Schedules

```typescript
// Exponential backoff with max 5 retries
const policy = Schedule.exponential("100 millis").pipe(
  Schedule.intersect(Schedule.recurs(5)),
);

effect.pipe(Effect.retry(policy));
```

## Config Module

⚪ **Not used yet.** Environment access currently goes through
`app/helpers/env.server.ts`, not Effect's `Config`. If we want validated,
typed, redacted config wired into the layer graph, this is the path.

Type-safe configuration from environment variables:

```typescript
import { Config } from "effect";

const config = yield* Config.struct({
  cacheEnabled: Config.boolean("CACHE_ENABLED"),
  timeout: Config.duration("USER_TIMEOUT"),
  port: Config.number("PORT"),
});
```

## Resource Management

⚪ **Not used at the effect level.** We manage resource lifetimes at the **Layer**
boundary instead — `Layer.scoped` + `Effect.acquireRelease` (e.g.
`PostHogService` flush-on-shutdown in `app/effects/posthog.ts`, the SQLite client
in `app/Database.ts`). Reach for `acquireUseRelease` only for a resource scoped
to a single operation rather than the app lifetime.

Safe acquire/use/release pattern:

```typescript
const managed = Effect.acquireUseRelease(
  // Acquire
  openConnection(),
  // Use
  (conn) => doWork(conn),
  // Release (always runs)
  (conn) => closeConnection(conn),
);
```

## Queue Patterns

🟢 **Core.** Bounded and unbounded queues for producer/consumer patterns:

```typescript
import { Queue } from "effect";

const queue = yield* Queue.bounded<Task>(100);

// Producer
yield* Queue.offer(queue, task);

// Consumer
const task = yield* Queue.take(queue);
```

**In this codebase:** `Queue.sliding<DiscordEvent>(1024)` in the
`DiscordEventBus` Layer provides backpressure-aware buffering between
Discord.js callbacks and Effect Stream consumers. The sliding strategy drops
oldest events under pressure rather than blocking the callback thread.
`Effect.runFork(Queue.offer(queue, event))` bridges from callback-land to
Effect without blocking.

## Ref / TRef State Management

🟡 **Used.** Mutable references for state within Effect. In the codebase, `Ref`
+ `Deferred` implement cross-request single-flight (so two concurrent requests
for the same thread don't both create it) in `app/models/userThreads.ts` and
`app/models/deletionLogThreads.ts`.

```typescript
import { Ref } from "effect";

const counter = yield* Ref.make(0);
yield* Ref.update(counter, (n) => n + 1);
const value = yield* Ref.get(counter);
```

> Note: the in-memory caches (`guildCache.server.ts`, the spam honeypot cache)
> currently use a plain `TTLCache`/`Map` read inside the Effect, **not** `Ref`.
> That's a known inconsistency, not the recommended target — prefer `Ref` (or
> `SynchronizedRef` for compute-on-miss) for new mutable state so access goes
> through the Effect runtime.

## Fiber Supervision

🟡 **Used.** The six event pipelines are `Effect.forkDaemon`ed at startup and
`Fiber.interrupt`ed + re-forked on HMR (`app/server.ts`); `SupervisorService`
(`app/effects/supervisor.ts`) registers an Effect `Supervisor` so background job
fibers are observable. Note the distinction: **`forkDaemon`** (not `fork`) for
anything that must outlive the fiber that spawned it — see EFFECT.md →
"Runtime & Boundaries".

```typescript
// Fork a background task tied to the current scope
const fiber = yield* Effect.fork(backgroundTask);

// Fork a daemon that outlives the spawning fiber (what the pipelines use)
const daemon = yield* Effect.forkDaemon(longLivedTask);

// Wait for it later, or interrupt it
const result = yield* Fiber.join(fiber);
yield* Fiber.interrupt(daemon);
```

## Adapting Callback-based APIs

⚪ **Rare.** The Promise→Effect migration is essentially complete; most external
APIs we touch are Promise-based (use `Effect.tryPromise` / `tryDiscord`). Reach
for `Effect.async` only for a genuinely callback-style API (no Promise):

```typescript
// Convert callback-based APIs to Effect
const readFile = (path: string): Effect.Effect<string, FileError, never> =>
  Effect.async<string, FileError>((resume) => {
    fs.readFile(path, "utf8", (err, data) => {
      if (err) resume(Effect.fail(new FileError(err.message)));
      else resume(Effect.succeed(data));
    });
  });
```

## Class-based Service → Effect Service

🟡 This is exactly how `UserService` (`app/models/user.server.ts`) is built — it
captures `db` once at layer construction, so its methods require nothing
(`R = never`). It's the one model-layer `Context.Tag`; the rest of the models are
free functions (see EFFECT.md → "Data Access"). Keep this shape in mind when a
class needs to become a service:

```typescript
// Before: class-based
class UserService {
  constructor(private db: Database) {}
  async getUser(id: string): Promise<User> { ... }
}

// After: Effect service
interface IUserService {
  readonly getUser: (id: string) => Effect.Effect<User, UserError>;
}

export class UserService extends Context.Tag("UserService")<
  UserService,
  IUserService
>() {}

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    return {
      getUser: (id) => Effect.gen(function* () { ... }),
    };
  }),
);
```
