# Effect Quick Reference

Quick lookup for patterns used in this codebase. For onboarding and
explanations — including the runtime boundary and the Stream-based event
pipelines that form the core architecture — see [EFFECT.md](./EFFECT.md). For
patterns we don't use yet (Sink, Config module, callback adapters), see
[EFFECT_ADVANCED.md](./EFFECT_ADVANCED.md).

## Error Handling

### Defining Errors

All errors use `Data.TaggedError` for type-safe discrimination:

```typescript
import { Data } from "effect";

export class MyError extends Data.TaggedError("MyError")<{
  field: string;
  message: string;
}> {}
```

**File:** `app/effects/errors.ts`

### Our Error Types

**Domain & infrastructure errors** (`app/effects/errors.ts`). `_tag` always
equals the class name.

| Error                      | Fields                                              | Used For                           |
| -------------------------- | -------------------------------------------------- | ---------------------------------- |
| `NotFoundError`            | `resource, id`                                      | Missing DB records                 |
| `NotAuthorizedError`       | `operation, userId, requiredRole?`                  | Permission failures                |
| `ValidationError`          | `field, message`                                    | Input validation failures          |
| `ConfigError`              | `key, message`                                      | Missing/invalid configuration      |
| `DatabaseCorruptionError`  | `errors`                                            | Integrity check failures           |
| `AlreadyResolvedError`     | `escalationId, resolvedAt`                          | Double-resolution attempts         |
| `NoLeaderError`            | `escalationId, reason, tiedResolutions?`            | Vote tallying with no clear winner |
| `ResolutionExecutionError` | `escalationId, resolution, cause`                   | Mod action execution failures      |
| `FeatureDisabledError`     | `feature, guildId, reason`                          | Hard feature-flag gate (`guardFeature`) |
| `SubscriptionNotFoundError`| `guildId`                                           | Missing guild subscription         |
| `StripeError`              | `operation, cause`                                  | Stripe SDK call failures           |
| `OAuthFetchError`          | `operation, status?, cause`                         | Discord OAuth fetch failures       |
| `SqlError`                 | (re-exported from `effect/sql`)                    | Database query failures            |

**Discord transport taxonomy** — named by the *decision* they drive, not the
HTTP family. The first six are the `DiscordError` union, produced only by
`classifyDiscordError` (`app/effects/classifyDiscordError.ts`). See EFFECT.md →
"Decision-oriented errors" for the full rationale.

| Error                    | Retriable? | Fields                                       |
| ------------------------ | ---------- | -------------------------------------------- |
| `RateLimitError`         | ✅ retriable | `source, operation, retryAfterMs, cause`    |
| `TransientError`         | ✅ retriable | `source, operation, status?, cause`         |
| `ForbiddenError`         | ❌          | `source, operation, cause`                   |
| `ResourceMissingError`   | ❌          | `source, operation, cause`                   |
| `ClientError`            | ❌          | `source, operation, status, code?, cause`    |
| `ServerError`            | ❌          | `source, operation, status, cause` (declared; no classifier branch emits it yet) |
| `ServiceUnavailableError`| —          | `source, lastCause` — escalation product of `escalateExhausted`, **not** in `DiscordError` |

`AppError` (`errors.ts`) is the app-wide union — `DiscordError` + all the domain
errors above + `SqlError` + `Cause.UnknownError` — used for `toUserResponse`
exhaustiveness.

> **Gone:** `DiscordApiError` and `StripeApiError` no longer exist. Discord
> failures are now the `DiscordError` union (classified at the boundary); Stripe
> failures are `StripeError`.

### catch vs catchTag

```typescript
// catch — handle any error uniformly
effect.pipe(
  Effect.catch((error) => Effect.succeed(fallback)),
);

// catchTag — handle specific error types differently
effect.pipe(
  Effect.catchTag("NotFoundError", (e) =>
    Effect.succeed(defaultValue),
  ),
  // Pass the whole tagged error as `error` — never e.message / String(e).
  // The custom logger serializes _tag, fields, and cause; stringifying drops
  // all of it (enforced by the local/no-error-string-cast lint rule).
  Effect.catchTag("SqlError", (e) =>
    logEffect("error", "Handler", "DB error", { error: e }),
  ),
);
```

### Error Recovery in Pipelines

```typescript
// Catch and recover inside Effect.forEach or Effect.all
yield* Effect.forEach(items, (item) =>
  processItem(item).pipe(
    Effect.catch((error) =>
      logEffect("error", "Handler", "Item failed", {
        itemId: item.id,
        error, // pass the tagged error through — not String(error)
      }),
    ),
  ),
);
```

## Concurrency

### Parallel: Effect.all with `concurrency`

Use for independent operations that don't depend on each other. Pass
`concurrency` in the options — `Effect.all` without it runs **sequentially**, and
piping `Effect.withConcurrency` (v3) never changed that (it only affects
`concurrency: "inherit"`; it no longer exists in v4):

```typescript
const [a, b, c] = yield* Effect.all([fetchA(), fetchB(), fetchC()], {
  concurrency: "unbounded",
});
```

### Sequential: Effect.forEach

Default behavior — processes items one at a time. Use when rate limits apply:

```typescript
const results = yield* Effect.forEach(items, (item) =>
  processItem(item),
);
```

### When to Use Which

| Scenario                    | Use                                        |
| --------------------------- | ------------------------------------------ |
| Independent API calls       | `Effect.all(..., { concurrency })`         |
| Discord API calls in a loop | `Effect.forEach` (sequential, rate limits) |
| Operations with deps        | Sequential `yield*` in `Effect.gen`        |

## Services

Most code does **not** define a service. The default for data access is a free
`Effect`-returning function that runs queries with `run(db...)` — see
EFFECT.md → "Data Access: Free Effect Functions". Reach for a `Context.Service`
service only when you need lifetime-held state or a swappable implementation. The
nine production services are: `DatabaseService`, `DiscordEventBus`,
`MessageCacheService`, `SpamDetectionService`, `UserService`, `EscalationService`,
`FeatureFlagService`, `PostHogService`, `SupervisorService`.

### Context.Service Class Pattern

When you do define a service, use the class form (v4 replaced `Context.Tag`,
`Effect.Tag` and `Effect.Service` with this; note the type parameters come
first and the id second). The function form `Context.Service<T>("id")` appears
only in test doubles:

```typescript
export class MyService extends Context.Service<
  MyService,
  IMyService
>()("MyService") {}
```

### Layer.effect Implementation

Acquire dependencies with `yield* Dependency` inside the constructor. If the
dependency (e.g. `DatabaseService`) is already in `AppLayer`, you don't chain
`Layer.provide` — the runtime supplies it. Add `Layer.provide(...)` only to
close a requirement that `AppLayer` does *not* satisfy.

```typescript
export const MyServiceLive = Layer.effect(
  MyService,
  Effect.gen(function* () {
    // Capture the executor at construction so methods keep R = never
    const { run } = yield* DatabaseService; // satisfied by AppLayer
    return {
      method: Effect.fn("MyService.method")(function* (arg) {
        // yield* run(db.selectFrom(...))
      }),
    };
  }),
);
```

`Layer.effect` with acquire/release finalizers (`PostHogService`,
`FeatureFlagService`, `DiscordEventBus` — v4 folded `Layer.scoped` into
`Layer.effect`) and `Layer.succeed` (`SupervisorService`) are the other
construction shapes in use.

### Layer Composition

```typescript
// Merge independent layers
const AppLayer = Layer.mergeAll(LayerA, LayerB, LayerC);

// Chain a dependency a layer needs but the merge doesn't provide
const ServiceLayer = Layer.effect(MyService, impl).pipe(
  Layer.provide(DependencyLayer),
);
```

**Files:** `app/AppRuntime.ts` (`AppLayer` via `Layer.mergeAll`),
`app/Database.ts` (`DatabaseLayer`), `app/effects/supervisor.ts`
(`Layer.unwrap`)

## Observability

### withSpan

Add to every public function for tracing:

```typescript
myEffect.pipe(
  Effect.withSpan("operationName", {
    attributes: { key: "value" },
  }),
);
```

### logEffect

Structured logging at different levels:

```typescript
yield* logEffect("info", "ServiceName", "What happened", {
  contextKey: "value",
});
// Levels: "debug" | "info" | "warn" | "error"
```

### tapLog

Log without affecting the pipeline value:

```typescript
import { tapLog } from "#~/effects/observability";

const pipeline = fetchUser(id).pipe(
  tapLog("info", "UserService", "User fetched", (user) => ({
    userId: user.id,
  })),
);
```

### annotateCurrentSpan

Add data to the current tracing span:

```typescript
yield* Effect.annotateCurrentSpan({ processed: items.length });
```

**File:** `app/effects/observability.ts`

## Discord SDK Helpers

Wrappers for Discord.js operations. Each routes through `tryDiscord` (so
rejections become a classified `DiscordError`) and adds an
`Effect.withSpan("discord.<op>")`. The `*OrNull` / `*Safe` variants instead
swallow failures (error channel `never`) — use them only where a missing target
is genuinely fine.

### Available Functions

| Function                  | Returns               | Error         |
| ------------------------- | --------------------- | ------------- |
| `createChannel`           | created channel       | `DiscordError`|
| `fetchGuild`              | `Guild`               | `DiscordError`|
| `fetchChannel`            | channel               | `DiscordError`|
| `fetchChannelFromClient`  | `T` (generic)         | `DiscordError`|
| `fetchMember`             | `GuildMember`         | `DiscordError`|
| `fetchMemberOrNull`       | `GuildMember \| null` | never         |
| `fetchUser`               | `User`                | `DiscordError`|
| `fetchUserOrNull`         | `User \| null`        | never         |
| `fetchMessage`            | `Message`             | `DiscordError`|
| `deleteMessage`           | delete result         | `DiscordError`|
| `sendMessage`             | `Message`             | `DiscordError`|
| `editMessage`             | `Message`             | `DiscordError`|
| `messageReply`            | reply `Message`       | `DiscordError`|
| `resolveMessagePartial`   | `Message`             | `DiscordError`|
| `softbanMember`           | `void`                | `DiscordError`|
| `interactionReply`        | reply result          | `DiscordError`|
| `interactionDeferReply`   | defer result          | `DiscordError`|
| `interactionEditReply`    | edited reply          | `DiscordError`|
| `interactionFollowUp`     | follow-up `Message`   | `DiscordError`|
| `interactionUpdate`       | update result         | `DiscordError`|
| `interactionDeferUpdate`  | defer-update result   | `DiscordError`|
| `forwardMessageSafe`      | `void`                | never (logs)  |
| `replyAndForwardSafe`     | `Message \| null`     | never (logs)  |

### Pattern: Adding a New Helper

Wrap the SDK call with `tryDiscord(operation, () => promise)` and add a span —
`tryDiscord` does the rejection→`DiscordError` classification for you, so you
never hand-construct a Discord error:

```typescript
import { tryDiscord } from "#~/effects/classifyDiscordError";

export const myNewHelper = (guild: Guild, arg: string) =>
  tryDiscord("myNewHelper", () => guild.someMethod(arg)).pipe(
    Effect.withSpan("discord.myNewHelper", { attributes: { arg } }),
  );
```

For null-safe variants, drop to raw `tryPromise` and recover to `null` (error
channel becomes `never`):

```typescript
export const myNewHelperOrNull = (guild: Guild, arg: string) =>
  Effect.tryPromise({
    try: () => guild.someMethod(arg),
    catch: () => null,
  }).pipe(
    Effect.catch(() => Effect.succeed(null)),
    Effect.withSpan("discord.myNewHelperOrNull"),
  );
```

**File:** `app/effects/discordSdk.ts` (wrappers),
`app/effects/classifyDiscordError.ts` (`tryDiscord`)

## Database Patterns

### DatabaseService

Kysely is a **compile-only typed query builder** (`db`: SqliteAdapter +
SqliteQueryCompiler + DummyDriver, no connection). Queries execute through the
effect/sql `SqlClient` via `DatabaseService.run`, so `SqlError`, `sql.execute`
spans and `withTransaction` all come from effect/sql. The free `run(query)` is
`Effect<Rows<O>, SqlError, DatabaseService>`, typed from Kysely's
`Compilable<O>`; writes without `returning` are typed `never[]` (they yield no
rows). `run` binds `undefined` params as NULL and returns plain-object rows —
the contract the v3 better-sqlite3 driver had (v4's driver is `node:sqlite`).

```typescript
interface Database {
  readonly run: <O>(query: Compilable<O>) => Effect.Effect<Rows<O>, SqlError>;
}
export class DatabaseService extends Context.Service<
  DatabaseService,
  Database
>()("DatabaseService") {}
```

Never call Kysely's `.execute()` — the DummyDriver returns nothing.

### Querying

```typescript
// Build with the compile-only `db` builder, execute with `run`.
import { db, run } from "#~/Database";

// Select
const rows = yield* run(
  db.selectFrom("table").selectAll().where("column", "=", value),
);
const [first] = yield* run(db.selectFrom("table").selectAll().limit(1));

// Insert / update / delete — without `returning(...)` these yield no rows
yield* run(db.insertInto("table").values({ ... }));
yield* run(db.updateTable("table").set({ column: newValue }).where("id", "=", id));
yield* run(db.deleteFrom("table").where("id", "=", id));

// Need the written row? Ask for it.
const [inserted] = yield* run(db.insertInto("table").values({ ... }).returning("id"));
```

### Layer Setup

```typescript
// SqliteClient.layer provides SqliteClient + SqlClient (WAL and a 5s
// busy_timeout are driver defaults); DatabaseService wraps the SqlClient.
export const makeDatabaseLayer = (filename: string) => {
  const client = SqliteClient.layer({ filename });
  return Layer.merge(
    client,
    Layer.effect(DatabaseService, makeDatabase).pipe(Layer.provide(client)),
  );
};
export const DatabaseLayer = makeDatabaseLayer(databaseUrl);
```

Tests use `makeDatabaseLayer(":memory:")` — the layer exposes both the raw
`SqlClient` (for `sql.unsafe` schema setup) and `DatabaseService`.

`DatabaseLayer` is merged into `AppLayer` in `app/AppRuntime.ts`, so effects
that `run(...)` need no per-call `Layer.provide` — the
`ManagedRuntime` already supplies it (see EFFECT.md → "Runtime & Boundaries").

**File:** `app/Database.ts`

## Effect Constructors Quick Reference

| Need              | Use                 | Example                               |
| ----------------- | ------------------- | ------------------------------------- |
| Pure value        | `Effect.succeed`    | `Effect.succeed(42)`                  |
| Pure error        | `Effect.fail`       | `Effect.fail(new MyError(...))`       |
| Sync side effect  | `Effect.sync`       | `Effect.sync(() => Date.now())`       |
| Async side effect | `Effect.tryPromise` | `Effect.tryPromise({ try, catch })`   |
| Generator body    | `Effect.gen`        | `Effect.gen(function* () { ... })`    |
| Do nothing        | `Effect.void`       | `Effect.void`                         |
