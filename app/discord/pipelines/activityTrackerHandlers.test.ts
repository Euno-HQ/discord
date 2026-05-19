/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/prefer-nullish-coalescing */
import { ChannelType } from "discord.js";
import { Context, Effect, Layer } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  handleMessageCreate,
  handleMessageDelete,
} from "./activityTrackerHandlers";

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

const mockInsertInto = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue(Effect.void),
});
const mockDeleteFrom = vi.fn().mockReturnValue({
  where: vi.fn().mockReturnValue(Effect.void),
});

vi.mock("#~/AppRuntime", () => ({
  runEffect: vi.fn(),
  RuntimeContext: {},
  db: {
    insertInto: (...args: any[]) => mockInsertInto(...args),
    deleteFrom: (...args: any[]) => mockDeleteFrom(...args),
  },
}));

vi.mock("#~/helpers/discord.js", () => ({
  getMessageStats: vi.fn().mockReturnValue(
    Effect.succeed({
      char_count: 10,
      word_count: 2,
      code_stats: [],
      link_stats: [],
      has_attachment: false,
      attachment_count: 0,
      has_embed: false,
      embed_count: 0,
      has_sticker: false,
      sticker_count: 0,
      react_count: 0,
    }),
  ),
}));

vi.mock("#~/discord/utils", () => ({
  getOrFetchChannel: vi.fn().mockResolvedValue({ category: "general" }),
}));

vi.mock("#~/helpers/metrics", () => ({
  threadStats: { messageTracked: vi.fn() },
}));

// --- Helpers ---

const runHandler = (effect: Effect.Effect<void, unknown, any>) =>
  // @ts-expect-error - test mock: RuntimeContext services are vi.mocked
  Effect.runPromise(effect);

const makeCreateEvent = (overrides: any = {}) => ({
  type: "GuildMemberMessage" as const,
  message: {
    id: "msg-1",
    author: {
      id: "user-1",
      tag: "User#0001",
      system: false,
      bot: false,
    },
    webhookId: null,
    channel: { type: ChannelType.GuildText },
    channelId: "channel-1",
    content: "hello world",
    mentions: { repliedUser: null },
    ...(overrides.message || {}),
  },
  guild: { id: "guild-1", ...(overrides.guild || {}) },
  member: { id: "user-1", ...(overrides.member || {}) },
});

const makeDeleteEvent = (overrides: any = {}) => ({
  type: "GuildMessageDelete" as const,
  message: {
    id: "msg-1",
    system: false,
    author: { id: "user-1", bot: false },
    ...(overrides.message || {}),
  },
  guild: { id: "guild-1", ...(overrides.guild || {}) },
  guildId: "guild-1",
});

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleMessageCreate", () => {
  test("returns early for system messages", async () => {
    const event = makeCreateEvent({
      message: { author: { system: true, bot: false, id: "sys-1" } },
    });

    await runHandler(handleMessageCreate(event as any));

    expect(mockInsertInto).not.toHaveBeenCalled();
  });

  test("returns early for bot messages", async () => {
    const event = makeCreateEvent({
      message: { author: { system: false, bot: true, id: "bot-1" } },
    });

    await runHandler(handleMessageCreate(event as any));

    expect(mockInsertInto).not.toHaveBeenCalled();
  });

  test("returns early for webhook messages", async () => {
    const event = makeCreateEvent({
      message: { webhookId: "webhook-1" },
    });

    await runHandler(handleMessageCreate(event as any));

    expect(mockInsertInto).not.toHaveBeenCalled();
  });

  test("returns early for non-trackable channel types", async () => {
    const event = makeCreateEvent({
      message: { channel: { type: ChannelType.DM } },
    });

    await runHandler(handleMessageCreate(event as any));

    expect(mockInsertInto).not.toHaveBeenCalled();
  });

  test("inserts stats for valid human messages", async () => {
    const event = makeCreateEvent();

    await runHandler(handleMessageCreate(event as any));

    expect(mockInsertInto).toHaveBeenCalledWith("message_stats");
  });

  test("tracks messages in trackable channel types", async () => {
    for (const channelType of [
      ChannelType.GuildText,
      ChannelType.GuildForum,
      ChannelType.PublicThread,
    ]) {
      vi.clearAllMocks();
      const event = makeCreateEvent({
        message: { channel: { type: channelType } },
      });

      await runHandler(handleMessageCreate(event as any));

      expect(mockInsertInto).toHaveBeenCalledWith("message_stats");
    }
  });
});

describe("handleMessageDelete", () => {
  test("returns early for system messages", async () => {
    const event = makeDeleteEvent({
      message: { system: true },
    });

    await runHandler(handleMessageDelete(event as any));

    expect(mockDeleteFrom).not.toHaveBeenCalled();
  });

  test("returns early for bot messages", async () => {
    const event = makeDeleteEvent({
      message: { author: { bot: true } },
    });

    await runHandler(handleMessageDelete(event as any));

    expect(mockDeleteFrom).not.toHaveBeenCalled();
  });

  test("deletes stats for human message deletions", async () => {
    const event = makeDeleteEvent();

    await runHandler(handleMessageDelete(event as any));

    expect(mockDeleteFrom).toHaveBeenCalledWith("message_stats");
  });

  test("proceeds when author is null (not a bot)", async () => {
    const event = makeDeleteEvent({
      message: { author: null, system: false },
    });

    await runHandler(handleMessageDelete(event as any));

    expect(mockDeleteFrom).toHaveBeenCalledWith("message_stats");
  });
});
