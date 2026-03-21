/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/prefer-nullish-coalescing */
import { Context, Effect, Layer } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { fetchGuild } from "#~/models/guilds.server";

import { handleGuildCreate, handleGuildDelete } from "./onboardGuildHandlers";

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
  botStats: {
    guildJoined: vi.fn(),
    guildRemoved: vi.fn(),
  },
}));
vi.mock("#~/models/guilds.server", () => ({
  fetchGuild: vi.fn(),
}));
vi.mock("#~/discord/deployCommands.server", () => ({
  deployToGuild: vi.fn().mockResolvedValue(undefined),
}));

// --- Helpers ---

const runHandler = (effect: Effect.Effect<void, unknown, any>) =>
  // @ts-expect-error - test mock: RuntimeContext services are vi.mocked
  Effect.runPromise(effect);

const makeGuildCreateEvent = (overrides: any = {}) => ({
  type: "GuildCreate" as const,
  guild: {
    id: "guild-1",
    name: "Test Guild",
    systemChannel: null,
    publicUpdatesChannel: null,
    channels: {
      fetch: vi.fn().mockResolvedValue({
        filter: () => ({ values: () => [].values() }),
      }),
    },
    ...(overrides.guild || {}),
  },
});

const makeGuildDeleteEvent = (overrides: any = {}) => ({
  type: "GuildDelete" as const,
  guild: {
    id: "guild-1",
    name: "Test Guild",
    available: true,
    ...(overrides.guild || {}),
  },
});

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleGuildCreate", () => {
  test("skips welcome and deploy when guild already exists (reconnect)", async () => {
    const { deployToGuild } = await import("#~/discord/deployCommands.server");
    vi.mocked(fetchGuild).mockResolvedValue({ id: "guild-1" } as any);

    const event = makeGuildCreateEvent();
    await runHandler(handleGuildCreate(event as any));

    expect(deployToGuild).not.toHaveBeenCalled();
  });

  test("deploys commands for new guild install", async () => {
    const { deployToGuild } = await import("#~/discord/deployCommands.server");
    vi.mocked(fetchGuild).mockResolvedValue(undefined as any);

    const event = makeGuildCreateEvent();
    await runHandler(handleGuildCreate(event as any));

    expect(deployToGuild).toHaveBeenCalled();
  });

  test("always emits guildJoined metric", async () => {
    const { botStats } = await import("#~/helpers/metrics");

    vi.mocked(fetchGuild).mockResolvedValue({ id: "guild-1" } as any);

    const event = makeGuildCreateEvent();
    await runHandler(handleGuildCreate(event as any));

    expect(botStats.guildJoined).toHaveBeenCalledWith(event.guild);
  });
});

describe("handleGuildDelete", () => {
  test("returns early when guild is temporarily unavailable", async () => {
    const { botStats } = await import("#~/helpers/metrics");

    const event = makeGuildDeleteEvent({
      guild: { available: false },
    });

    await runHandler(handleGuildDelete(event as any));

    expect(fetchGuild).not.toHaveBeenCalled();
    expect(botStats.guildRemoved).not.toHaveBeenCalled();
  });

  test("returns early when guild not found in DB", async () => {
    const { botStats } = await import("#~/helpers/metrics");
    vi.mocked(fetchGuild).mockResolvedValue(undefined as any);

    const event = makeGuildDeleteEvent();
    await runHandler(handleGuildDelete(event as any));

    expect(fetchGuild).toHaveBeenCalledWith("guild-1");
    expect(botStats.guildRemoved).not.toHaveBeenCalled();
  });

  test("emits guildRemoved metric when guild exists in DB", async () => {
    const { botStats } = await import("#~/helpers/metrics");
    vi.mocked(fetchGuild).mockResolvedValue({ id: "guild-1" } as any);

    const event = makeGuildDeleteEvent();
    await runHandler(handleGuildDelete(event as any));

    expect(botStats.guildRemoved).toHaveBeenCalledWith(event.guild);
  });
});
