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
| `SqlError`                 | (re-exported from `@effect/sql`)                    | Database query failures            |

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
errors above + `SqlError` + `Cause.UnknownException` — used for `toUserResponse`
exhaustiveness.

> **Gone:** `DiscordApiError` and `StripeApiError` no longer exist. Discord
> failures are now the `DiscordError` union (classified at the boundary); Stripe
> failures are `StripeError`.

### catchAll vs catchTag

```typescript
// catchAll — handle any error uniformly
effect.pipe(
  Effect.catchAll((error) => Effect.succeed(fallback)),
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
    Effect.catchAll((error) =>
      logEffect("error", "Handler", "Item failed", {
        itemId: item.id,
        error, // pass the tagged error through — not String(error)
      }),
    ),
  ),
);
```

## Concurrency

### Parallel: Effect.all + withConcurrency

Use for independent operations that don't depend on each other:

```typescript
const [a, b, c] = yield* Effect.all([
  fetchA(),
  fetchB(),
  fetchC(),
]).pipe(Effect.withConcurrency("unbounded"));
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
| Independent API calls       | `Effect.all` + `withConcurrency`           |
| Discord API calls in a loop | `Effect.forEach` (sequential, rate limits) |
| Operations with deps        | Sequential `yield*` in `Effect.gen`        |

## Services

Most code does **not** define a service. The default for data access is a free
`Effect`-returning function that does `const db = yield* DatabaseService` — see
EFFECT.md → "Data Access: Free Effect Functions". Reach for a `Context.Tag`
service only when you need lifetime-held state or a swappable implementation. The
nine production Tag services are: `DatabaseService`, `DiscordEventBus`,
`MessageCacheService`, `SpamDetectionService`, `UserService`, `EscalationService`,
`FeatureFlagService`, `PostHogService`, `SupervisorService`.

### Context.Tag Class Pattern

When you do define a service, use the class-`Tag` pattern — not
`Context.GenericTag` (which appears only in test doubles):

```typescript
export class MyService extends Context.Tag("MyService")<
  MyService,
  IMyService
>() {}
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
    const db = yield* DatabaseService; // satisfied by AppLayer
    return {
      method: (arg) =>
        Effect.gen(function* () {
          // use db
        }).pipe(Effect.withSpan("method")),
    };
  }),
);
```

`Layer.scoped` (acquire/release finalizers — `PostHogService`,
`FeatureFlagService`, `DiscordEventBus`) and `Layer.unwrapEffect`
(`SupervisorService`) are the other two construction shapes in use.

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
(`Layer.unwrapEffect`)

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
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.withSpan("discord.myNewHelperOrNull"),
  );
```

**File:** `app/effects/discordSdk.ts` (wrappers),
`app/effects/classifyDiscordError.ts` (`tryDiscord`)

## Database Patterns

### DatabaseService

The database is an effectified Kysely instance provided as a service:

```typescript
export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  EffectKysely
>() {}
```

### Querying

```typescript
const db = yield* DatabaseService;

// Select
const rows = yield* db
  .selectFrom("table")
  .selectAll()
  .where("column", "=", value);

// Insert
yield* db.insertInto("table").values({ ... });

// Update
yield* db
  .updateTable("table")
  .set({ column: newValue })
  .where("id", "=", id);

// Delete
yield* db
  .deleteFrom("table")
  .where("id", "=", id);
```

### Layer Setup

```typescript
// Base SQLite client (WAL on by default). busy_timeout pragma applied on
// acquire; Reactivity is a required dependency of @effect/sql-kysely.
const SqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({ filename: databaseUrl }).pipe(
    Effect.tap((sql) => sql.unsafe("PRAGMA busy_timeout = 5000")),
  ),
).pipe(Layer.provide(Reactivity.layer));

// Kysely builder, exposed as DatabaseService, on top of the SQLite client
const KyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(SqliteLive),
);

// Combined layer exposes BOTH the raw SqlClient (for sql.unsafe / PRAGMA /
// integrity checks) and the Kysely DatabaseService
export const DatabaseLayer = Layer.mergeAll(SqliteLive, KyselyLive);
```

`DatabaseLayer` is merged into `AppLayer` in `app/AppRuntime.ts`, so effects
that `yield* DatabaseService` need no per-call `Layer.provide` — the
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
