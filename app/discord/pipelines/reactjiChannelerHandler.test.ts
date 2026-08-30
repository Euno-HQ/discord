/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/prefer-nullish-coalescing */
import { Context, Effect, Layer } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { Resource } from "@effect/opentelemetry";
import { SqlClient } from "@effect/sql";

import type { RuntimeContext } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";
import { DiscordClient } from "#~/discord/client.server";
import { DiscordEventBus } from "#~/discord/eventBus";
import { MessageCacheService } from "#~/discord/messageCacheService";
import { FeatureFlagService } from "#~/effects/featureFlags";
import { PostHogService } from "#~/effects/posthog";
import { SupervisorService } from "#~/effects/supervisor";
import { SpamDetectionService } from "#~/features/spam/service";
import { UserService } from "#~/models/user.server";

import { handleReactionAdd } from "./reactjiChannelerHandler";

// Mock all external dependencies
vi.mock("#~/helpers/observability", () => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  log: () => {},
}));
vi.mock("#~/effects/observability", () => ({
  logEffect: () => Effect.void,
}));
vi.mock("#~/discord/client.server", () => ({
  client: {},
  DiscordClient: Context.GenericTag("DiscordClient"),
  DiscordClientLayer: Layer.empty,
}));
vi.mock("#~/Database", () => ({
  DatabaseService: Context.GenericTag("DatabaseService"),
  DatabaseLayer: Layer.empty,
}));
vi.mock("#~/helpers/metrics", () => ({
  featureStats: { reactjiTriggered: vi.fn() },
}));

// --- Helpers ---

const makeMockDb = (configs: any[] = []) => ({
  selectFrom: () => ({
    selectAll: () => ({
      where: () => ({
        where: () => Effect.succeed(configs),
      }),
    }),
  }),
});

// Typed stub for a service that's never touched at runtime in this file (its
// real call sites are vi.mocked away). Proxy methods throw if called, so a
// test that starts depending on it fails loudly instead of silently seeing
// `undefined` — and since it's typed at the tag's service type, a signature
// change on the interface is still a compile error at the call site.
const unusedService = <T extends object>(name: string): T =>
  new Proxy({} as T, {
    get: (_t, prop) => () => {
      throw new Error(
        `${name}.${String(prop)} called unexpectedly in a test that stubs it as unused`,
      );
    },
  });

// Services beyond DatabaseService are unused by this handler (its real call
// sites are vi.mocked below), but the handler's declared type is
// RuntimeContext, so every tag it carries must be supplied for the R channel
// to close to `never` — that's what proves no new dependency snuck in unnoticed.
const restOfRuntimeContext = Layer.mergeAll(
  Layer.succeed(
    SqlClient.SqlClient,
    unusedService<Context.Tag.Service<typeof SqlClient.SqlClient>>("SqlClient"),
  ),
  Resource.layerEmpty,
  // PostHogService's Service type is `PostHog | null`; `null` is a real,
  // valid value (means "PostHog disabled") rather than a cast, so it needs
  // no throwing-proxy stub.
  Layer.succeed(PostHogService, null),
  Layer.succeed(
    FeatureFlagService,
    unusedService<Context.Tag.Service<typeof FeatureFlagService>>(
      "FeatureFlagService",
    ),
  ),
  Layer.succeed(
    SpamDetectionService,
    unusedService<Context.Tag.Service<typeof SpamDetectionService>>(
      "SpamDetectionService",
    ),
  ),
  Layer.succeed(
    SupervisorService,
    unusedService<Context.Tag.Service<typeof SupervisorService>>(
      "SupervisorService",
    ),
  ),
  Layer.succeed(
    DiscordClient,
    unusedService<Context.Tag.Service<typeof DiscordClient>>("DiscordClient"),
  ),
  Layer.succeed(
    DiscordEventBus,
    unusedService<Context.Tag.Service<typeof DiscordEventBus>>(
      "DiscordEventBus",
    ),
  ),
  Layer.succeed(
    UserService,
    unusedService<Context.Tag.Service<typeof UserService>>("UserService"),
  ),
  Layer.succeed(
    MessageCacheService,
    unusedService<Context.Tag.Service<typeof MessageCacheService>>(
      "MessageCacheService",
    ),
  ),
);

const runHandler = (
  effect: Effect.Effect<void, never, RuntimeContext>,
  db = makeMockDb(),
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DatabaseService, db as any),
          restOfRuntimeContext,
        ),
      ),
    ),
  );

const makeReactionEvent = (overrides: any = {}) => ({
  type: "MessageReactionAdd" as const,
  reaction: {
    partial: false,
    emoji: { id: null, name: "⭐", animated: false },
    count: 5,
    message: {
      id: "msg-1",
      partial: false,
      guild: {
        id: "guild-1",
        channels: { fetch: vi.fn() },
      },
      fetch: vi.fn(),
      forward: vi.fn().mockResolvedValue({}),
    },
    users: {
      fetch: vi.fn().mockResolvedValue({
        filter: () => [],
        map: () => [],
      }),
    },
    ...(overrides.reaction || {}),
  },
  user: { id: "user-1", bot: false, ...(overrides.user || {}) },
});

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleReactionAdd", () => {
  test("returns early for bot reactions", async () => {
    const db = makeMockDb();
    const event = makeReactionEvent({ user: { bot: true } });

    await runHandler(handleReactionAdd(event as any), db);

    // Should not even query the database
    // (bot check happens before DB query)
  });

  test("returns early when message has no guild", async () => {
    const event = makeReactionEvent({
      reaction: {
        emoji: { id: null, name: "⭐", animated: false },
        count: 5,
        message: { id: "msg-1", partial: false, guild: null },
        users: { fetch: vi.fn() },
      },
    });

    await runHandler(handleReactionAdd(event as any));
  });

  test("returns early when emoji name is null", async () => {
    const event = makeReactionEvent({
      reaction: {
        emoji: { id: null, name: null, animated: false },
        count: 5,
        message: {
          id: "msg-1",
          partial: false,
          guild: { id: "guild-1", channels: { fetch: vi.fn() } },
        },
        users: { fetch: vi.fn() },
      },
    });

    await runHandler(handleReactionAdd(event as any));
  });

  test("returns early when no config exists for the emoji", async () => {
    const db = makeMockDb([]); // no configs
    const event = makeReactionEvent();

    await runHandler(handleReactionAdd(event as any), db);

    // No forwarding should happen
    expect(event.reaction.message.forward).not.toHaveBeenCalled();
  });

  test("returns early when reaction count does not match threshold", async () => {
    const db = makeMockDb([
      {
        guild_id: "guild-1",
        emoji: "⭐",
        channel_id: "target-1",
        threshold: 10,
      },
    ]);
    const event = makeReactionEvent(); // count is 5, threshold is 10

    await runHandler(handleReactionAdd(event as any), db);

    expect(event.reaction.message.forward).not.toHaveBeenCalled();
  });

  test("forwards message when reaction count matches threshold", async () => {
    const mockTargetChannel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({}),
    };

    const db = makeMockDb([
      {
        guild_id: "guild-1",
        emoji: "⭐",
        channel_id: "target-1",
        threshold: 5,
      },
    ]);

    const event = makeReactionEvent();
    event.reaction.message.guild.channels.fetch = vi
      .fn()
      .mockResolvedValue(mockTargetChannel);
    event.reaction.users.fetch = vi.fn().mockResolvedValue({
      filter: (fn: any) => [{ id: "user-1", bot: false }].filter(fn),
      map: (fn: any) => [{ id: "user-1", bot: false }].map(fn),
    });

    await runHandler(handleReactionAdd(event as any), db);

    expect(event.reaction.message.forward).toHaveBeenCalledWith(
      mockTargetChannel,
    );
  });

  test("uses custom emoji format for custom emojis", async () => {
    const mockTargetChannel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({}),
    };

    const db = makeMockDb([
      {
        guild_id: "guild-1",
        emoji: "<:custom:123456>",
        channel_id: "target-1",
        threshold: 5,
      },
    ]);

    const event = makeReactionEvent({
      reaction: {
        emoji: { id: "123456", name: "custom", animated: false },
        count: 5,
        message: {
          id: "msg-1",
          partial: false,
          guild: {
            id: "guild-1",
            channels: {
              fetch: vi.fn().mockResolvedValue(mockTargetChannel),
            },
          },
          fetch: vi.fn(),
          forward: vi.fn().mockResolvedValue({}),
        },
        users: {
          fetch: vi.fn().mockResolvedValue({
            filter: (fn: any) => [{ id: "user-1", bot: false }].filter(fn),
            map: (fn: any) => [{ id: "user-1", bot: false }].map(fn),
          }),
        },
      },
    });

    await runHandler(handleReactionAdd(event as any), db);

    expect(event.reaction.message.forward).toHaveBeenCalledWith(
      mockTargetChannel,
    );
  });

  test("returns early when target channel is not text-based", async () => {
    const mockTargetChannel = {
      isTextBased: () => false,
    };

    const db = makeMockDb([
      {
        guild_id: "guild-1",
        emoji: "⭐",
        channel_id: "target-1",
        threshold: 5,
      },
    ]);

    const event = makeReactionEvent();
    event.reaction.message.guild.channels.fetch = vi
      .fn()
      .mockResolvedValue(mockTargetChannel);

    await runHandler(handleReactionAdd(event as any), db);

    expect(event.reaction.message.forward).not.toHaveBeenCalled();
  });

  test("fetches partial reaction before processing", async () => {
    const fetchedReaction = {
      partial: false,
      emoji: { id: null, name: "⭐", animated: false },
      count: 5,
      message: {
        id: "msg-1",
        partial: false,
        guild: null, // Will cause early return after fetch
      },
      users: { fetch: vi.fn() },
    };

    const event = makeReactionEvent({
      reaction: {
        partial: true,
        fetch: vi.fn().mockResolvedValue(fetchedReaction),
        emoji: { id: null, name: "⭐", animated: false },
        message: { id: "msg-1" },
      },
    });

    await runHandler(handleReactionAdd(event as any));

    expect(event.reaction.fetch).toHaveBeenCalled();
  });
});
