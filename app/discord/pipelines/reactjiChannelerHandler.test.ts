/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/prefer-nullish-coalescing */
import { Context, Effect, Layer } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseService } from "#~/Database";

import { handleReactionAdd } from "./reactjiChannelerHandler";

// Mock all external dependencies
vi.mock("#~/helpers/observability", () => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  log: () => {},
}));
vi.mock("#~/effects/observability", () => ({
  logEffect: () => Effect.void,
}));
vi.mock("#~/discord/client.server", () => ({ client: {} }));
vi.mock("#~/Database", () => ({
  DatabaseService: Context.GenericTag("DatabaseService"),
  DatabaseLayer: Layer.empty,
}));
vi.mock("#~/AppRuntime", () => ({
  runEffect: vi.fn(),
  RuntimeContext: {},
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

const runHandler = (
  effect: Effect.Effect<void, unknown, any>,
  db = makeMockDb(),
) =>
  Effect.runPromise(
    // @ts-expect-error - test mock: RuntimeContext services are vi.mocked
    effect.pipe(Effect.provide(Layer.succeed(DatabaseService, db))),
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
