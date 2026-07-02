# Effect in This Codebase

This document gets you reading and writing Effect code in this codebase. It
covers the patterns we actually use, with references to real files. For a quick
lookup reference, see [EFFECT_REFERENCE.md](./EFFECT_REFERENCE.md).

## Effect Stays on the Server

**Principle:** Effect never leaves the server. It lives in `*.server.ts` modules
(or confirmed server-only directories: `app/effects/**`, `app/discord/**`,
`app/commands/**`, `app/jobs/**`, `app/models/**`, plus `app/server.ts`,
`app/AppRuntime.ts`, `app/Database.ts`). Client code — route component parts,
`app/components/**`, `app/root.tsx`, `app/entry.client.tsx` — reaches Effect work
**only through route loaders/actions**, never by importing `effect`/`@effect/*` or
a server module directly. React Router v7 + Vite strips `*.server.{ts,tsx}` from
the client build and tree-shakes loaders/actions out of client chunks, so server
code reached that way is safe; importing Effect from genuinely client-reachable
code would pull the whole library into the browser bundle.

Two guards enforce this so it can't regress:

- **Lint rule (fast feedback):** a scoped `no-restricted-imports` block in
  `eslint.config.js` forbids `effect`, `effect/*`, and `@effect/*` imports from
  client-reachable app source. Runs as part of `npm run lint` (`--max-warnings=0`).
  Server zones are allowlisted via the block's `ignores`. Server-only files that
  lack a `.server.ts` suffix (e.g. `app/helpers/discord.ts`,
  `app/features/spam/*`) get narrow per-file exceptions — prefer renaming such
  files to `*.server.ts` over widening the allowlist.
- **CI bundle check (authoritative net):** `npm run check:client-bundle` builds
  the client and inspects the emitted sourcemaps' `sources` for any
  `node_modules/effect` / `node_modules/@effect` path (a grep won't work — the
  bundle is minified and Effect is inlined). It fails if Effect reached the
  client graph. The script deletes the `.map` files it generates afterward so
  they don't linger in the CI workspace; this does NOT govern what the
  production image ships (the prod build runs `npm run build`, and client
  sourcemap policy is a separate concern not changed here). Wired into CI as the
  `client-bundle` job; run it locally with `npm run check:client-bundle`.

## Runtime & Boundaries

Effects are lazy descriptions — nothing runs until something executes them. This
codebase has exactly **one** runtime: a `ManagedRuntime` built from `AppLayer`
and exported as `runtime` in `app/AppRuntime.ts`. `AppLayer` merges every
service (Database, PostHog, FeatureFlag, MessageCache, DiscordEventBus,
Supervisor, SpamDetection, User, Escalation) and stays open for the whole
process lifetime, so its resources — the SQLite connection, the PostHog flush
finalizer, the broadcast event queue — live as long as the bot does.

Because the services live in `AppLayer`, code that `yield* DatabaseService` (or
any other app service) **never needs a per-call `Layer.provide`** — the runtime
already supplies the whole context. The requirement type these effects carry is
`RuntimeContext` (`AppRuntime.ts`).

You only execute an effect at a **boundary** — the edge between Effect-land and
the outside (an HTTP request, a Discord callback, process startup):

| Boundary helper | What it does | Used at |
| --- | --- | --- |
| `runEffect(effect)` | `runtime.runPromise` — run to a `Promise<A>` | route loaders/actions, the gateway interaction handler, schedulers |
| `runEffectExit(effect)` | `runtime.runPromiseExit` — run to an `Exit` (no throw) | callers that must inspect success/failure |
| `Effect.forkDaemon` | fork a long-lived background fiber off the runtime | the six event pipelines, started in `server.ts` |

**`forkDaemon`, not `fork`.** The pipelines are forked with `Effect.forkDaemon`
(`server.ts`) specifically so they outlive the `startup` fiber that spawns them —
a plain `Effect.fork` would tie their lifetime to startup and they'd be
interrupted the moment it finished. On HMR the previous fibers are
`Fiber.interrupt`ed and re-forked. This distinction is load-bearing; don't
"simplify" it to `fork`.

> The deprecated raw-Kysely bridges (`run`/`runTakeFirst`/
> `runTakeFirstOrThrow`/lazy `db` proxy) are gone; async callers now cross the
> boundary only through the helpers in the table above (`runEffect`/
> `runEffectExit` and the flag helpers built on them), always with a real
> Effect from a free model function (e.g. `app/models/*.server.ts`), typically
> as `await runEffect(modelFn(...))`.

## Reading Effect Code

### The Mental Model

Effect is like async/await but with:

- **Explicit error types** — errors are part of the type signature, not just
  `throw`
- **Dependency injection built-in** — services are declared as type parameters
  and provided at composition time
- **Composable operations** — everything chains with `.pipe()` and composes with
  `yield*`

The type `Effect.Effect<Success, Error, Requirements>` describes a lazy
computation that:

- Produces a `Success` value
- May fail with an `Error`
- Requires `Requirements` (services) to run

### The Core Pattern

Every Effect operation in this codebase looks like:

```typescript
export const myHandler = (input: Input) =>
  Effect.gen(function* () {
    // 1. Get dependencies
    const service = yield* MyService;

    // 2. Do work (yield* unwraps Effects)
    const result = yield* service.doSomething(input);

    // 3. Return value
    return result;
  }).pipe(
    // DatabaseLayer is provided by the ManagedRuntime — no need to provide it here
    Effect.catchAll((e) => ...), // Handle errors
    Effect.withSpan("myHandler"), // Add tracing
  );
```

### What `yield*` Does

`yield*` is like `await` — it unwraps an Effect and gives you the value:

- `const user = yield* fetchUser(id)` — user is `User`, not `Effect<User>`
- `const db = yield* DatabaseService` — db is the service implementation
- If the Effect fails, execution stops and the error propagates

### The `.pipe()` Pattern

`.pipe()` chains operations left-to-right. Read it top to bottom:

```typescript
someEffect.pipe(
  Effect.map((x) => x + 1), // Transform success value
  Effect.catchAll((e) => ...), // Handle errors
  Effect.withSpan("name"), // Add tracing
);
```

### How to Trace Through Existing Code

When reading a function like `processEscalationEffect` in
`app/commands/escalate/escalationResolver.ts`:

1. Find the `Effect.gen(function* () { ... })` — this is the body
2. Each `yield*` is an async step that can fail
3. Look at the `.pipe(...)` at the end for error handling and tracing
4. Follow `yield* SomeService` to find what services are used
5. Check the calling code for `Effect.provide(...)` to see where dependencies
   come from

## Patterns We Use

### Error Handling

We use tagged errors for type-safe error handling. Each error has a `_tag` field
that TypeScript uses for discrimination:

```typescript
// Define errors (see app/effects/errors.ts)
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  resource: string;
  id: string;
}> {}
```

Catch specific errors by tag:

```typescript
effect.pipe(
  Effect.catchTag("NotFoundError", (e) =>
    Effect.succeed(defaultValue),
  ),
);
```

Catch all errors uniformly:

```typescript
effect.pipe(
  Effect.catchAll((error) =>
    logEffect("error", "Handler", "Operation failed", {
      error,
    }),
  ),
);
```

**See:** `app/effects/errors.ts` for all error types

#### Decision-oriented errors (infra taxonomy)

Discord transport errors live in `app/effects/errors.ts` and are named by the
decision they drive, not by HTTP family:

`type DiscordError` is the union of the six transport/classifier outputs below (excludes `ServiceUnavailableError`, which is an escalation product):

| Tag | Decision |
|---|---|
| `RateLimitError` | Retriable — carries `retryAfterMs` for observability |
| `TransientError` | Retriable — 5xx/network fault, optional `status` |
| `ForbiddenError` | Non-retriable — bot lacks a Discord permission; give guidance |
| `ResourceMissingError` | Non-retriable — target gone; frequently recover-as-success |
| `ClientError` | Non-retriable — other 4xx |
| `ServerError` | Non-retriable, permanent 5xx — named slot, no classifier branch emits it yet |

`ServiceUnavailableError` is separate — an escalation product from `escalateExhausted`, NOT emitted by `classifyDiscordError`, NOT a member of `DiscordError`:

| Tag | Decision |
|---|---|
| `ServiceUnavailableError` | Escalated outage — exhausted retriable failure, carries `lastCause` |

`type AppError` is the app-wide union (DiscordError + domain errors + SqlError +
`Cause.UnknownException`) used for `toUserResponse` exhaustiveness.

**Classifier boundary** (`app/effects/classifyDiscordError.ts`): the only place
`instanceof` against `@discordjs/rest` SDK errors is allowed. Converts an
unknown rejection to a typed `DiscordError`:

```typescript
// Only place SDK instanceof checks live — the unknown→typed boundary:
const e: DiscordError = classifyDiscordError("addRole", rejection);

// DRY replacement for Effect.tryPromise({ try, catch }) at every Discord call site:
yield* tryDiscord("addMemberRole", () =>
  ssrDiscordSdk.put(Routes.guildMemberRole(guildId, userId, roleId)),
);
```

**Decision helpers** (`app/effects/errorHandling.ts`):

```typescript
// Membership guard over the six DiscordError tags:
if (isDiscordError(e)) { ... }

// Retriable predicate (RateLimitError | TransientError):
if (isRetriable(e)) { ... }

// Retry transient failures with capped exponential backoff (base 200ms, ×2,
// jittered) — Schedule.exponential("200 millis", 2) |> jittered |>
// compose(recurs(3)) = 1 initial attempt + 3 retries = 4 total:
yield* tryDiscord("op", fn).pipe(withRetry);

// Map a surviving retriable failure to ServiceUnavailableError (alert path):
yield* tryDiscord("op", fn).pipe(withRetry, escalateExhausted);

// Pure, total mapper from any AppError tag to safe user copy:
const reply = toUserResponse(e); // { content: string; ephemeral: boolean }
```

**Before / after — job: retry transient, drop member-gone**
(`app/jobs/bulkRoleAssignment.ts`)

```typescript
// before: log-and-drop every failure, no distinction
// after:
yield* tryDiscord("addMemberRole", () => ssrDiscordSdk.put(...)).pipe(
  withRetry,                                            // RateLimit/Transient retried
  Effect.catchTag("ResourceMissingError", () => Effect.void), // member gone → fine
  Effect.exit,
);
// NOTE: escalateExhausted is NOT used here — one member's outage must not abort
// a 100k-member migration. escalateExhausted suits command handlers where a
// single failure IS the whole outcome.
```

**Before / after — command handler: structured error → user reply**

```typescript
// before: ad-hoc generic string
// after:
Effect.catchAll((e) =>
  Effect.all([
    logEffect("error", "Commands", "Operation failed", { error: e }), // full structured payload
    interactionReply(interaction, toUserResponse(e)),                  // safe, specific-where-known
  ]),
)
```

**See:** `app/effects/errors.ts` (taxonomy), `app/effects/classifyDiscordError.ts`
(boundary), `app/effects/errorHandling.ts` (helpers)

### Parallel Operations

Use `Effect.all` with `withConcurrency("unbounded")` for independent operations:

```typescript
const [settings, reportedUser, guild, channel] = yield* Effect.all([
  fetchSettingsEffect(escalation.guild_id, [SETTINGS.modLog]),
  fetchUserOrNull(client, escalation.reported_user_id),
  fetchGuild(client, escalation.guild_id),
  fetchChannelFromClient<ThreadChannel>(client, escalation.thread_id),
]).pipe(Effect.withConcurrency("unbounded"));
```

**See:** `app/commands/escalate/escalationResolver.ts:94-102`

### Sequential Operations (Rate-Limited)

Use `Effect.forEach` when items must be processed one at a time (e.g., Discord
rate limits):

```typescript
const results = yield* Effect.forEach(due, (escalation) =>
  processEscalationEffect(client, escalation).pipe(
    Effect.catchAll((error) =>
      logEffect("error", "EscalationResolver", "Error processing escalation", {
        escalationId: escalation.id,
        error,
      }),
    ),
  ),
);
```

**See:** `app/commands/escalate/escalationResolver.ts:186-197`

### Event Pipelines (Streams)

Discord events are processed through **Effect `Stream` pipelines** — this is the
backbone of the bot, not an advanced extra. The flow:

1. `DiscordEventBus` (`app/discord/eventBus.ts`) is a `Layer.scoped` service that
   registers ~18 `client.on(...)` discord.js listeners. Each listener enriches
   the raw event into a tagged `DiscordEvent` and offers it to a
   `Queue.sliding(1024)` (drops oldest under load rather than blocking the
   callback). The queue is exposed as a `Stream.broadcastDynamic` so every
   pipeline gets its own independently-backpressured copy.
2. Each of the six pipelines (`app/discord/pipelines/*`) subscribes to that
   stream, narrows by event type, optionally gates on a feature flag, and
   dispatches a handler — all as `Effect.Effect<void, never, RuntimeContext>`.
3. `server.ts` forks all six with `Effect.forkDaemon` at startup.

The canonical pipeline body (`app/discord/pipelines/automod.ts`):

```typescript
export const automodPipeline: Effect.Effect<void, never, RuntimeContext> =
  Effect.gen(function* () {
    const { stream } = yield* DiscordEventBus;
    const spamService = yield* SpamDetectionService;

    yield* stream.pipe(
      Stream.filter(isGuildMemberMessage), // type-guard narrows the event
      Stream.mapEffect((e) =>
        handleMessage(e, spamService).pipe(
          // per-event recovery: one failure must NOT kill the stream
          Effect.catchAll((err) =>
            logEffect("warn", "Automod", "Pipeline handler failed", {
              ...logContext(e),
              error: err, // tagged error passed whole, never stringified
            }),
          ),
        ),
      ),
      Stream.runDrain,
    );
  });
```

Key idioms:

- **`never` error channel is structural.** Every handler ends in
  `Effect.catchAll`, so the pipeline type is `…, never, …`. A pipeline that can
  fail would tear down on the first bad event; the type makes that impossible.
- **`Stream.filter` with a type-guard** narrows `DiscordEvent` to the variant a
  pipeline cares about. Use `Stream.filterEffect` when the gate is itself an
  Effect (e.g. a feature-flag check — `deletionLogger.ts`).
- **`filterLog`** (`app/effects/observability.ts`) filters *and* logs the drop,
  so "not flagged" is distinguishable from "never evaluated."
- **`Stream.tap`** for side effects that don't change the value (cache touches).
- **`Stream.runDrain`** consumes the stream forever.

To add a pipeline: write an `Effect<void, never, RuntimeContext>` with this
shape, then fork it in `server.ts` alongside the others. The pure `enrich*`
functions in `eventBus.ts` are extracted precisely so the interesting logic is
unit-testable without a runtime.

**See:** `app/discord/eventBus.ts`, `app/discord/pipelines/*.ts`, `app/server.ts`

### Data Access: Free Effect Functions

**This is the dominant pattern in the codebase.** Most data access is *not* a
service — it's a plain exported function that returns an `Effect` and pulls the
database out of context on its first line:

```typescript
// app/models/guilds.server.ts — the shape almost every model function takes
export const fetchGuild = (guildId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const rows = yield* db
      .selectFrom("guilds")
      .selectAll()
      .where("id", "=", guildId);
    return rows[0]; // may be undefined — callers handle the miss
  }).pipe(Effect.withSpan("Guild.fetchGuild", { attributes: { guildId } }));
```

These functions have requirement type `DatabaseService` (satisfied by the
runtime). Callers compose them with `yield*` inside larger Effects, or cross a
boundary with `await runEffect(fetchGuild(id))`. The Kysely builder is itself
yieldable — `yield* db.selectFrom(...)` runs the query; there's no `.execute()`.
DB failures surface automatically as `SqlError` in the error channel; domain
"not found" is either a plain `undefined` return (`fetchGuild`) or a deliberate
`Effect.fail(new NotFoundError(...))` (`fetchSettings`).

**Never call `.pipe()` (or any method-style combinator) on the effectified
builder itself** — it typechecks but crashes at runtime. @effect/sql-kysely
wraps the builder in a proxy, the proxy wraps the method's return value too, and
the Effect runtime throws a proxy-invariant `TypeError` on `Symbol(effect/Hash)`
when it touches the result. `yield*` the builder directly, or use data-first
combinators:

```typescript
// WRONG — runtime TypeError:
yield* db.selectFrom("guilds").selectAll().pipe(Effect.map((rows) => rows[0]));

// RIGHT — yield* the builder directly:
const rows = yield* db.selectFrom("guilds").selectAll();
// or data-first combinators:
yield* Effect.map(db.selectFrom("guilds").selectAll(), (rows) => rows[0]);
```

The model files (`app/models/*.server.ts`) are the reference for this pattern.
`subscriptions.server.ts` and `stripe.server.ts` group their free functions
under an exported object (`SubscriptionService` / `StripeService`) for
namespacing — note these are **plain objects of functions, not `Context.Tag`
services** despite the name.

> There are no DB transactions in the codebase — idempotency leans on SQLite
> upserts (`onConflict`) plus in-process `Ref`/`Deferred` single-flight for
> cross-request dedup (`app/models/userThreads.ts`). If you need atomicity
> across multiple writes, that's new ground; design it deliberately.

### Services & Dependency Injection

Reach for a `Context.Tag` service only when a free function won't do — when you
need **lifetime-held state** (an in-memory cache, a Supervisor registration, a
long-lived connection) or a **swappable implementation**. The nine production
services are `DatabaseService`, `DiscordEventBus`, `MessageCacheService`,
`SpamDetectionService`, `UserService`, `EscalationService`, `FeatureFlagService`,
`PostHogService`, and `SupervisorService` — everything else in the model/helper
layers is free functions.

`UserService` is the one model-layer service: it captures `db` once at layer
construction, so its methods require nothing (`R = never`) rather than
`DatabaseService` per call.

A service has three parts: an interface, a tag, and a live implementation.

**1. Define the interface:**

```typescript
export interface IEscalationService {
  readonly getEscalation: (
    id: string,
  ) => Effect.Effect<Escalation, NotFoundError | SqlError>;
  // ...
}
```

**2. Create the tag (using class pattern):**

```typescript
export class EscalationService extends Context.Tag("EscalationService")<
  EscalationService,
  IEscalationService
>() {}
```

**3. Implement with Layer.effect:**

```typescript
export const EscalationServiceLive = Layer.effect(
  EscalationService,
  Effect.gen(function* () {
    const db = yield* DatabaseService; // satisfied by AppLayer — no Layer.provide
    return {
      getEscalation: (id) =>
        Effect.gen(function* () {
          // implementation using db
        }),
    };
  }),
);
```

**4. Use in handlers:**

```typescript
const escalationService = yield* EscalationService;
const votes = yield* escalationService.getVotesForEscalation(escalation.id);
```

**See:** `app/commands/escalate/service.ts` (full service),
`app/Database.ts` (simpler service)

### Observability

**Tracing with `withSpan`:**

```typescript
Effect.withSpan("operationName", {
  attributes: {
    escalationId: escalation.id,
    resolution,
  },
});
```

**Structured logging with `logEffect`:**

```typescript
yield* logEffect("info", "ServiceName", "What happened", {
  key: "contextual data",
});
```

**Annotating the current span:**

```typescript
yield* Effect.annotateCurrentSpan({ processed: due.length });
```

**See:** `app/effects/observability.ts` for `logEffect` and `tapLog`

### Promise Integration

**For Discord calls, use `tryDiscord`** — don't hand-roll `Effect.tryPromise`
with a hand-constructed error. `tryDiscord(operation, () => promise)` wraps the
call and classifies any rejection into a typed `DiscordError` at the boundary
(see "Decision-oriented errors" above):

```typescript
export const fetchGuild = (client: Client, guildId: string) =>
  tryDiscord("fetchGuild", () => client.guilds.fetch(guildId)).pipe(
    Effect.withSpan("discord.fetchGuild", { attributes: { guildId } }),
  );
```

**For other Promise-based APIs** (Stripe, OAuth fetches, the PostHog SDK), use
`Effect.tryPromise` directly and map to the relevant tagged error — e.g.
`StripeError`, `OAuthFetchError`:

```typescript
const tryStripe = (operation: string, fn: () => Promise<T>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new StripeError({ operation, cause }),
  });
```

For cases where failure is acceptable (returns null), drop the typed error and
recover (error channel becomes `never`):

```typescript
export const fetchMemberOrNull = (guild: Guild, userId: string) =>
  Effect.tryPromise({
    try: () => guild.members.fetch(userId),
    catch: () => null,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
```

**See:** `app/effects/discordSdk.ts` (Discord wrappers),
`app/effects/classifyDiscordError.ts` (`tryDiscord`),
`app/models/stripe.server.ts` (`tryStripe`)

## Writing New Code

### Checklist

1. **Reach for a free function first** — an exported `(args) => Effect.gen(...)`
   that does `const db = yield* DatabaseService`. Only define a `Context.Tag`
   service if you need lifetime-held state or a swappable implementation.
2. **Define errors** — add to `app/effects/errors.ts` using `Data.TaggedError`;
   for Discord calls, let `tryDiscord` produce the `DiscordError` for you
3. **Implement with `Effect.gen`** — see `guilds.server.ts` for a typical model
   function, `escalationResolver.ts` for complex orchestration
4. **If it's an event reaction, write a pipeline** — not an ad-hoc
   `client.on(...)`; add a `Stream` pipeline and fork it in `server.ts`
5. **Add observability** — `Effect.withSpan()` on every public function;
   `logEffect()` (with the tagged error passed whole) for important events
6. **A new service?** — then also define the interface + tag + Layer and merge
   it into `AppLayer` (`app/AppRuntime.ts`)

### Template: New Handler

```typescript
import { Effect } from "effect";
import { DatabaseService } from "#~/Database";
import { logEffect } from "#~/effects/observability";

export const handleMyCommand = (input: Input) =>
  Effect.gen(function* () {
    // Get services
    const db = yield* DatabaseService;

    // Do work
    const result = yield* db.selectFrom("table").selectAll().where(...);

    yield* logEffect("info", "MyCommand", "Handled command", {
      inputId: input.id,
    });

    return result;
  }).pipe(
    // DatabaseLayer is provided by the ManagedRuntime — no need to provide it here
    Effect.catchAll((error) =>
      logEffect("error", "MyCommand", "Command failed", {
        error,
      }),
    ),
    Effect.withSpan("handleMyCommand"),
  );
```

### Template: New Service

```typescript
import { Context, Effect, Layer } from "effect";
import { DatabaseService } from "#~/Database";

// 1. Interface
export interface IMyService {
  readonly doThing: (id: string) => Effect.Effect<Result, MyError>;
}

// 2. Tag
export class MyService extends Context.Tag("MyService")<
  MyService,
  IMyService
>() {}

// 3. Implementation
// DatabaseService is provided by the ManagedRuntime, no Layer.provide needed
export const MyServiceLive = Layer.effect(
  MyService,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    return {
      doThing: (id) =>
        Effect.gen(function* () {
          // Use db here
        }).pipe(
          Effect.withSpan("doThing", { attributes: { id } }),
        ),
    };
  }),
);
```

## Anti-Patterns

### Don't nest `Effect.runPromise`

```typescript
// WRONG — breaks the Effect chain, loses error types
const bad = Effect.gen(function* () {
  const result = yield* Effect.tryPromise(async () => {
    const data = await Effect.runPromise(someEffect);
    return processData(data);
  });
});

// RIGHT — keep everything in the Effect chain
const good = Effect.gen(function* () {
  const data = yield* someEffect;
  return processData(data);
});
```

### Don't create services in business logic

```typescript
// WRONG — bypasses dependency injection
const bad = Effect.gen(function* () {
  const db = new DatabaseService();
  return yield* db.getUser("123");
});

// RIGHT — use yield* to get injected services
const good = Effect.gen(function* () {
  const db = yield* DatabaseService;
  return yield* db.getUser("123");
});
```

### Don't ignore error types

```typescript
// WRONG — swallows all error information
const bad = effect.pipe(
  Effect.catchAll(() => Effect.succeed(null)),
);

// RIGHT — handle errors specifically
const good = effect.pipe(
  Effect.catchTag("NotFoundError", () => Effect.succeed(defaultValue)),
);
```

### Don't wrap pure functions in Effect

```typescript
// WRONG — unnecessary Effect wrapper
const add = (a: number, b: number): Effect.Effect<number> =>
  Effect.succeed(a + b);

// RIGHT — keep pure functions pure
const add = (a: number, b: number): number => a + b;
```

## Model Files

These are the best files to study when learning how Effect is used here:

- **`app/AppRuntime.ts`** — the single `ManagedRuntime`, `AppLayer` composition,
  and the `runEffect` boundary
- **`app/discord/eventBus.ts`** + **`app/discord/pipelines/automod.ts`** — the
  Stream-based event-pipeline architecture (queue → broadcast → filter →
  mapEffect → runDrain)
- **`app/models/guilds.server.ts`** — the dominant free-Effect-function data
  pattern (`yield* DatabaseService`, yieldable Kysely, `withSpan`)
- **`app/commands/escalate/escalationResolver.ts`** — parallel operations,
  sequential rate-limited processing, error recovery, span annotations
- **`app/effects/discordSdk.ts`** + **`app/effects/classifyDiscordError.ts`** —
  `tryDiscord` Promise wrapping and boundary error classification
- **`app/commands/escalate/service.ts`** — the full `Context.Tag` service pattern
  (interface, tag, Layer) for the cases that need one
- **`app/Database.ts`** — Layer composition, merging independent layers
- **`app/effects/observability.ts`** — `logEffect`, `tapLog`, `filterLog`
- **`app/effects/errors.ts`** + **`app/effects/errorHandling.ts`** —
  `Data.TaggedError` taxonomy and the `withRetry`/`toUserResponse` helpers

## Unit Testing

### When to write unit tests for Effect code

Effect code that coordinates external services (Discord API, database) is hard
to unit test and the mocking overhead often isn't worth it. Focus tests where
they provide clear value:

1. **Pure functions extracted from Effects** — like the `enrich*` functions in
   `app/discord/eventBus.ts`. They take inputs, return outputs, no services
   needed. Easy to test, high value.

2. **Business logic decisions in handlers** — like the deletion log handlers in
   `app/discord/pipelines/deletionLogHandlers.ts`. When a handler has meaningful
   branching (cached vs. uncached, mod vs. self-deletion), test the decision
   logic by mocking services.

3. **Effect combinators and utilities** — like `withFeatureFlag` and
   `guardFeature` in `app/effects/featureFlags.ts`. Pure Effect logic that
   doesn't depend on external state.

Don't bother testing:

- Thin wrappers around Discord.js API calls (`app/effects/discordSdk.ts`)
- Layer construction / service wiring (tested by the app starting)
- Stream pipeline composition (tested via integration / manual testing)

### Patterns

**1. Pure function tests** — no Effect runtime needed, just call and assert:

```typescript
// app/discord/eventBus.test.ts
it("returns null for bot messages", () => {
  const msg = makeMessage({ author: { bot: true, system: false } });
  expect(enrichMessageCreate(msg)).toBeNull();
});
```

**2. Effect tests with mock services** — provide mock implementations via
`Layer.succeed`, run with `Effect.runPromise`:

```typescript
// app/effects/featureFlags.test.ts — mock the service interface directly
const makeMockFlags = (enabled: boolean): IFeatureFlagService => ({
  isPostHogEnabled: (_flag, _guildId) => Effect.succeed(enabled),
  // ...
});
const exit = await Effect.runPromiseExit(guardFeature(flags, "analytics", "guild-1"));
expect(Exit.isSuccess(exit)).toBe(true);

// app/discord/pipelines/deletionLogHandlers.test.ts — Layer.succeed for tag-based injection
const runHandler = (effect, cache = makeMockCache()) =>
  Effect.runPromise(
    // @ts-expect-error - test mock
    effect.pipe(Effect.provide(Layer.succeed(MessageCacheService, cache))),
  );
```

**3. Mocking heavy transitive deps** — use `vi.mock()` for modules the test
file doesn't directly use but its imports pull in:

```typescript
// app/effects/featureFlags.test.ts
vi.mock("#~/Database", () => ({
  DatabaseService: { key: "DatabaseService" },
  DatabaseLayer: {},
}));
vi.mock("#~/effects/posthog", () => ({
  PostHogService: { key: "PostHogService" },
  PostHogServiceLive: {},
}));

// app/discord/pipelines/deletionLogHandlers.test.ts
vi.mock("#~/Database", () => ({
  DatabaseService: Context.GenericTag("DatabaseService"),
  DatabaseLayer: Layer.empty,
}));
vi.mock("#~/AppRuntime", () => ({
  runEffect: vi.fn(),
  RuntimeContext: {},
}));
// Per-test control via vi.mocked():
vi.mocked(fetchSettingsEffect).mockReturnValue(Effect.succeed(null) as any);
```

### Tips

- The global test setup (`test/setup-test-env.ts`) already mocks
  `#~/helpers/observability` — you don't need to mock `log()` in every test
  file. Mock `#~/effects/observability` separately if the code under test calls
  `logEffect`.
- For handler tests that need `RuntimeContext`, mock all service modules with
  `vi.mock()` and provide only the service the handler actually `yield*`s via
  `Layer.succeed` (see `deletionLogHandlers.test.ts` for the full pattern).
- Use `@ts-expect-error` on `Effect.provide(...)` calls when the mocked services
  don't fully satisfy the `RuntimeContext` type — this is acceptable in tests.

## Further Reading

Much of the Effect-TS docs are
[online in a compacted form](https://effect.website/llms-small.txt). The
unabridged versions of the documentation are
[indexed here](https://effect.website/llms.txt); you can retrieve a URL with
more detailed information from there.

For Effect patterns we don't use yet (Sink, the Config module, callback→Effect
adapters), see [EFFECT_ADVANCED.md](./EFFECT_ADVANCED.md). Streams, Queues,
Schedule, Ref, and Fiber supervision are all core here and documented above or
in [EFFECT_REFERENCE.md](./EFFECT_REFERENCE.md).
