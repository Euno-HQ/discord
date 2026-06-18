# Effect Advanced Patterns

Some of these patterns are now used in the codebase (Streams, Queues) while
others remain documented for future reference. For patterns we actually use, see
[EFFECT.md](./EFFECT.md) and [EFFECT_REFERENCE.md](./EFFECT_REFERENCE.md).

## Stream Processing

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

For retry and repeat logic beyond simple patterns:

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

Bounded and unbounded queues for producer/consumer patterns:

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

Mutable references for state within Effect:

```typescript
import { Ref } from "effect";

const counter = yield* Ref.make(0);
yield* Ref.update(counter, (n) => n + 1);
const value = yield* Ref.get(counter);
```

## Fiber Supervision

For advanced concurrent execution control:

```typescript
// Fork a background task
const fiber = yield* Effect.fork(backgroundTask);

// Wait for it later
const result = yield* Fiber.join(fiber);

// Or interrupt it
yield* Fiber.interrupt(fiber);
```

## Migration: Callback-based Code

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

## Migration: Class-based Services

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
