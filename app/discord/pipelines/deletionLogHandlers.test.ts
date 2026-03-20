/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/prefer-nullish-coalescing */
import { Context, Effect, Layer } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { fetchAuditLogEntry } from "#~/discord/auditLog";
import { MessageCacheService } from "#~/discord/messageCacheService";
import { fetchChannel, fetchUserOrNull } from "#~/effects/discordSdk";
import { getOrCreateDeletionLogThread } from "#~/models/deletionLogThreads";
import { fetchSettingsEffect } from "#~/models/guilds.server";
import { getOrCreateUserThread } from "#~/models/userThreads";

import {
  handleBulkDelete,
  handleDelete,
  handleEdit,
} from "./deletionLogHandlers";

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

// These will be controlled per-test via vi.mocked()
vi.mock("#~/models/guilds.server", () => ({
  fetchSettingsEffect: vi.fn(),
  SETTINGS: { deletionLog: "deletionLog", modLog: "modLog" },
}));
vi.mock("#~/discord/auditLog", () => ({
  fetchAuditLogEntry: vi.fn(),
  AUDIT_LOG_WINDOW_MS: 5000,
}));
vi.mock("#~/models/deletionLogThreads", () => ({
  getOrCreateDeletionLogThread: vi.fn(),
}));
vi.mock("#~/models/userThreads", () => ({
  getOrCreateUserThread: vi.fn(),
}));
vi.mock("#~/effects/discordSdk", () => ({
  fetchChannel: vi.fn(),
  fetchGuild: vi.fn(),
  fetchUserOrNull: vi.fn(),
}));
vi.mock("#~/helpers/discord", () => ({
  quoteMessageContent: (content: string) => `> ${content}`,
}));

// --- Helpers ---

const makeMockCache = (
  messages: Record<string, { user_id: string; content: string | null }> = {},
) => ({
  upsertMessage: () => Effect.void,
  touchMessage: () => Effect.void,
  getMessage: (id: string) => Effect.succeed(messages[id] as any),
  expireContent: () => Effect.void,
  expireRows: () => Effect.void,
});

const runHandler = (
  effect: Effect.Effect<void, unknown, any>,
  cache = makeMockCache(),
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.succeed(MessageCacheService, cache))),
  );

const makeDeleteEvent = (overrides: any = {}) => ({
  type: "GuildMessageDelete" as const,
  message: {
    id: "msg-1",
    partial: false,
    author: null as any,
    content: null,
    channelId: "channel-1",
    guildId: "guild-1",
    system: false,
    createdTimestamp: Date.now(),
    ...(overrides.message || {}),
  },
  guild: { id: "guild-1", ...(overrides.guild || {}) },
  guildId: "guild-1",
});

const makeEditEvent = (overrides: any = {}) => ({
  type: "GuildMessageUpdate" as const,
  oldMessage: { content: "old content", ...(overrides.oldMessage || {}) },
  newMessage: {
    id: "msg-1",
    content: "new content",
    author: { id: "user-1", tag: "User#0001" },
    channelId: "channel-1",
    createdTimestamp: Date.now(),
    url: "https://discord.com/msg",
    ...(overrides.newMessage || {}),
  },
  guild: { id: "guild-1", ...(overrides.guild || {}) },
  guildId: "guild-1",
});

const makeCollection = (messages: any[]) => {
  const map = new Map(messages.map((m, i) => [String(i), m]));
  return {
    first: () => messages[0],
    values: () => map.values(),
    size: messages.length,
  } as any;
};

const mockClient = {} as any;

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleDelete", () => {
  test("returns early when guild has no deletion log configured", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(Effect.succeed(null) as any);

    await runHandler(handleDelete(mockClient, makeDeleteEvent() as any));

    expect(getOrCreateDeletionLogThread).not.toHaveBeenCalled();
  });

  test("batches uncached deletions when no userId available", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(
      Effect.succeed({ deletionLog: "channel-1" }) as any,
    );

    const event = makeDeleteEvent({
      message: { author: null, content: null },
    });

    await runHandler(handleDelete(mockClient, event as any));

    // No userId => batching path, no thread created
    expect(getOrCreateDeletionLogThread).not.toHaveBeenCalled();
  });

  test("resolves author from cache when message author is null", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(
      Effect.succeed({ deletionLog: "channel-1" }) as any,
    );

    const mockThread = { send: vi.fn().mockResolvedValue({}) };
    vi.mocked(getOrCreateDeletionLogThread).mockReturnValue(
      Effect.succeed(mockThread) as any,
    );
    vi.mocked(fetchUserOrNull).mockReturnValue(
      Effect.succeed({ id: "user-1", tag: "User#0001" }) as any,
    );
    vi.mocked(fetchAuditLogEntry).mockReturnValue(
      Effect.succeed(undefined) as any,
    );

    const cache = makeMockCache({
      "msg-1": { user_id: "user-1", content: "hello" },
    });

    const event = makeDeleteEvent({
      message: { id: "msg-1", author: null, content: null },
    });

    await runHandler(handleDelete(mockClient, event as any), cache);

    expect(fetchUserOrNull).toHaveBeenCalledWith(mockClient, "user-1");
    expect(getOrCreateDeletionLogThread).toHaveBeenCalled();
  });

  test("posts to mod thread when audit log shows mod deletion", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(
      Effect.succeed({ deletionLog: "channel-1" }) as any,
    );

    const mockThread = { send: vi.fn().mockResolvedValue({}) };
    const mockModThread = { send: vi.fn().mockResolvedValue({}) };
    vi.mocked(getOrCreateDeletionLogThread).mockReturnValue(
      Effect.succeed(mockThread) as any,
    );
    vi.mocked(getOrCreateUserThread).mockReturnValue(
      Effect.succeed(mockModThread) as any,
    );
    vi.mocked(fetchAuditLogEntry).mockReturnValue(
      Effect.succeed({ executor: { id: "mod-1" } }) as any,
    );

    const event = makeDeleteEvent({
      message: {
        author: { id: "user-1", tag: "User#0001" },
        content: "deleted msg",
      },
    });

    await runHandler(handleDelete(mockClient, event as any));

    expect(getOrCreateUserThread).toHaveBeenCalled();
    expect(mockModThread.send).toHaveBeenCalled();
  });
});

describe("handleEdit", () => {
  test("returns early when guild has no deletion log configured", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(Effect.succeed(null) as any);

    await runHandler(handleEdit(mockClient, makeEditEvent() as any));

    expect(getOrCreateDeletionLogThread).not.toHaveBeenCalled();
  });

  test("returns early when newMessage has no author", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(
      Effect.succeed({ deletionLog: "channel-1" }) as any,
    );

    const event = makeEditEvent({
      newMessage: { author: null },
    });

    await runHandler(handleEdit(mockClient, event as any));

    expect(getOrCreateDeletionLogThread).not.toHaveBeenCalled();
  });

  test("prefers cached content as before text", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(
      Effect.succeed({ deletionLog: "channel-1" }) as any,
    );

    const mockThread = { send: vi.fn().mockResolvedValue({}) };
    vi.mocked(getOrCreateDeletionLogThread).mockReturnValue(
      Effect.succeed(mockThread) as any,
    );

    const cache = makeMockCache({
      "msg-1": { user_id: "user-1", content: "cached-before" },
    });

    const event = makeEditEvent({
      oldMessage: { content: "old-before" },
    });

    await runHandler(handleEdit(mockClient, event as any), cache);

    expect(mockThread.send).toHaveBeenCalled();
    const sentEmbed = mockThread.send.mock.calls[0][0].embeds[0].description;
    expect(sentEmbed).toContain("cached-before");
    expect(sentEmbed).not.toContain("old-before");
  });
});

describe("handleBulkDelete", () => {
  test("returns early when guild has no deletion log configured", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(Effect.succeed(null) as any);

    const event = {
      type: "GuildMessageBulkDelete" as const,
      messages: makeCollection([]),
      channel: { name: "general" },
      guild: { id: "guild-1" },
      guildId: "guild-1",
    };

    await runHandler(handleBulkDelete(mockClient, event as any));

    expect(fetchChannel).not.toHaveBeenCalled();
  });

  test("returns early when all messages are from bots", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(
      Effect.succeed({ deletionLog: "log-channel" }) as any,
    );

    const mockLogChannel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(fetchChannel).mockReturnValue(
      Effect.succeed(mockLogChannel) as any,
    );

    const messages = makeCollection([
      { author: { id: "bot-1", bot: true, tag: "Bot#0001" } },
      { author: { id: "bot-2", bot: true, tag: "Bot#0002" } },
    ]);

    const event = {
      type: "GuildMessageBulkDelete" as const,
      messages,
      channel: { name: "general" },
      guild: { id: "guild-1" },
      guildId: "guild-1",
    };

    await runHandler(handleBulkDelete(mockClient, event as any));

    // count of non-bot messages is 0, so it returns early
    expect(mockLogChannel.send).not.toHaveBeenCalled();
  });

  test("tallies non-bot messages per author", async () => {
    vi.mocked(fetchSettingsEffect).mockReturnValue(
      Effect.succeed({ deletionLog: "log-channel" }) as any,
    );

    const mockLogChannel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(fetchChannel).mockReturnValue(
      Effect.succeed(mockLogChannel) as any,
    );

    const messages = makeCollection([
      { author: { id: "user-1", bot: false, tag: "Alice#0001" } },
      { author: { id: "user-1", bot: false, tag: "Alice#0001" } },
      { author: { id: "user-2", bot: false, tag: "Bob#0002" } },
      { author: { id: "bot-1", bot: true, tag: "Bot#9999" } },
    ]);

    const event = {
      type: "GuildMessageBulkDelete" as const,
      messages,
      channel: { name: "general" },
      guild: { id: "guild-1" },
      guildId: "guild-1",
    };

    await runHandler(handleBulkDelete(mockClient, event as any));

    expect(mockLogChannel.send).toHaveBeenCalled();
    const embed = mockLogChannel.send.mock.calls[0][0].embeds[0];
    // 3 non-bot messages total
    expect(embed.description).toContain("3");
    // Author breakdown in fields
    const authorsField = embed.fields[0].value;
    expect(authorsField).toContain("Alice#0001");
    expect(authorsField).toContain("2 messages");
    expect(authorsField).toContain("Bob#0002");
    expect(authorsField).toContain("1 message");
    // Bot should not appear
    expect(authorsField).not.toContain("Bot#9999");
  });
});
