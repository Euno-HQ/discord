# Effect in This Codebase

This document gets you reading and writing Effect code in this codebase. It
covers the patterns we actually use, with references to real files. For a quick
lookup reference, see [EFFECT_REFERENCE.md](./EFFECT_REFERENCE.md).

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
      error: String(error),
    }),
  ),
);
```

**See:** `app/effects/errors.ts` for all error types

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
        error: String(error),
      }),
    ),
  ),
);
```

**See:** `app/commands/escalate/escalationResolver.ts:186-197`

### Services & Dependency Injection

Services have three parts: an interface, a tag, and a live implementation.

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
    const db = yield* DatabaseService;
    return {
      getEscalation: (id) =>
        Effect.gen(function* () {
          // implementation using db
        }),
    };
  }),
).pipe(Layer.provide(DatabaseLayer));
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

Use `Effect.tryPromise` to wrap external Promise-based APIs:

```typescript
export const fetchGuild = (client: Client, guildId: string) =>
  Effect.tryPromise({
    try: () => client.guilds.fetch(guildId),
    catch: (error) =>
      new DiscordApiError({ operation: "fetchGuild", cause: error }),
  });
```

For cases where failure is acceptable (returns null):

```typescript
export const fetchMemberOrNull = (guild: Guild, userId: string) =>
  Effect.tryPromise({
    try: () => guild.members.fetch(userId),
    catch: () => null,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
```

**See:** `app/effects/discordSdk.ts` for all Discord SDK wrappers

## Writing New Code

### Checklist

1. **Define errors** — add to `app/effects/errors.ts` using `Data.TaggedError`
2. **Define service interface** — see `app/commands/escalate/service.ts` for the
   pattern
3. **Implement with `Effect.gen`** — see `escalationResolver.ts` for complex
   examples
4. **Create a Layer** — see `app/Database.ts` for Layer composition
5. **Add observability** — use `Effect.withSpan()` on every public function, use
   `logEffect()` for important events

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
        error: String(error),
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

- **`app/commands/escalate/escalationResolver.ts`** — parallel operations,
  sequential processing, error recovery, span annotations
- **`app/effects/discordSdk.ts`** — Promise wrapping, error mapping,
  null-safe variants
- **`app/commands/escalate/service.ts`** — full service pattern with interface,
  tag, Layer, and dependency injection
- **`app/Database.ts`** — Layer composition, merging independent layers
- **`app/effects/observability.ts`** — `logEffect` and `tapLog` utilities
- **`app/effects/errors.ts`** — `Data.TaggedError` definitions

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

For patterns not used in this codebase (Streams, Schedules, etc.), see
[EFFECT_ADVANCED.md](./EFFECT_ADVANCED.md).
