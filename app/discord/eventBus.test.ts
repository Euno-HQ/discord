/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";

import {
  enrichMessageBulkDelete,
  enrichMessageCreate,
  enrichMessageDelete,
  enrichMessageUpdate,
} from "./eventBus";

vi.mock("#~/helpers/observability", () => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  log: () => {},
}));
vi.mock("#~/discord/client.server", () => ({
  client: {},
}));

// --- Helpers ---

const makeMessage = (overrides = {}) =>
  ({
    author: { bot: false, system: false },
    system: false,
    inGuild: () => true,
    guild: { id: "guild-1" },
    member: { id: "member-1" },
    guildId: "guild-1",
    channelId: "channel-1",
    ...overrides,
  }) as any;

const makeGuildCache = (
  guilds: Record<string, unknown> = { "guild-1": { id: "guild-1" } },
) => ({
  get: (id: string) => guilds[id] as any,
});

// --- Tests ---

describe("enrichMessageCreate", () => {
  it("returns null for bot messages", () => {
    const msg = makeMessage({ author: { bot: true, system: false } });
    expect(enrichMessageCreate(msg)).toBeNull();
  });

  it("returns null for system messages", () => {
    const msg = makeMessage({ author: { bot: false, system: true } });
    expect(enrichMessageCreate(msg)).toBeNull();
  });

  it("returns null for DMs", () => {
    const msg = makeMessage({ inGuild: () => false });
    expect(enrichMessageCreate(msg)).toBeNull();
  });

  it("returns null when member is missing", () => {
    const msg = makeMessage({ member: null });
    expect(enrichMessageCreate(msg)).toBeNull();
  });

  it("returns GuildMemberMessage with correct fields for a normal guild message", () => {
    const msg = makeMessage();
    const result = enrichMessageCreate(msg);
    expect(result).toEqual({
      type: "GuildMemberMessage",
      message: msg,
      guild: msg.guild,
      member: msg.member,
    });
  });
});

describe("enrichMessageDelete", () => {
  it("returns null for system messages", () => {
    const msg = makeMessage({ system: true });
    expect(enrichMessageDelete(msg, makeGuildCache())).toBeNull();
  });

  it("returns null for bot messages", () => {
    const msg = makeMessage({ author: { bot: true, system: false } });
    expect(enrichMessageDelete(msg, makeGuildCache())).toBeNull();
  });

  it("returns null when no guildId", () => {
    const msg = makeMessage({ guildId: null });
    expect(enrichMessageDelete(msg, makeGuildCache())).toBeNull();
  });

  it("returns null when guild not in cache", () => {
    const msg = makeMessage();
    expect(enrichMessageDelete(msg, makeGuildCache({}))).toBeNull();
  });

  it("returns GuildMessageDelete with correct fields when valid", () => {
    const msg = makeMessage();
    const cache = makeGuildCache();
    const result = enrichMessageDelete(msg, cache);
    expect(result).toEqual({
      type: "GuildMessageDelete",
      message: msg,
      guild: { id: "guild-1" },
      guildId: "guild-1",
    });
  });
});

describe("enrichMessageUpdate", () => {
  it("returns null when no guildId on newMessage", () => {
    const oldMsg = makeMessage({ content: "old" });
    const newMsg = makeMessage({ content: "new", guildId: null });
    expect(enrichMessageUpdate(oldMsg, newMsg, makeGuildCache())).toBeNull();
  });

  it("returns null for bot messages", () => {
    const oldMsg = makeMessage({ content: "old" });
    const newMsg = makeMessage({
      content: "new",
      author: { bot: true, system: false },
    });
    expect(enrichMessageUpdate(oldMsg, newMsg, makeGuildCache())).toBeNull();
  });

  it("returns null for system messages", () => {
    const oldMsg = makeMessage({ content: "old" });
    const newMsg = makeMessage({
      content: "new",
      author: { bot: false, system: true },
    });
    expect(enrichMessageUpdate(oldMsg, newMsg, makeGuildCache())).toBeNull();
  });

  it("returns null when content hasn't changed", () => {
    const oldMsg = makeMessage({ content: "same" });
    const newMsg = makeMessage({ content: "same" });
    expect(enrichMessageUpdate(oldMsg, newMsg, makeGuildCache())).toBeNull();
  });

  it("returns null when guild not in cache", () => {
    const oldMsg = makeMessage({ content: "old" });
    const newMsg = makeMessage({ content: "new" });
    expect(enrichMessageUpdate(oldMsg, newMsg, makeGuildCache({}))).toBeNull();
  });

  it("returns GuildMessageUpdate with correct fields when valid", () => {
    const oldMsg = makeMessage({ content: "old" });
    const newMsg = makeMessage({ content: "new" });
    const cache = makeGuildCache();
    const result = enrichMessageUpdate(oldMsg, newMsg, cache);
    expect(result).toEqual({
      type: "GuildMessageUpdate",
      oldMessage: oldMsg,
      newMessage: newMsg,
      guild: { id: "guild-1" },
      guildId: "guild-1",
    });
  });
});

describe("enrichMessageBulkDelete", () => {
  it("returns null when no guildId available", () => {
    const messages = {
      first: () => ({ guildId: null }),
    } as any;
    const channel = { guildId: null } as any;
    expect(
      enrichMessageBulkDelete(messages, channel, makeGuildCache()),
    ).toBeNull();
  });

  it("returns null when guild not in cache", () => {
    const messages = {
      first: () => ({ guildId: "guild-1" }),
    } as any;
    const channel = { guildId: "guild-1" } as any;
    expect(
      enrichMessageBulkDelete(messages, channel, makeGuildCache({})),
    ).toBeNull();
  });

  it("returns GuildMessageBulkDelete with correct fields when valid", () => {
    const messages = {
      first: () => ({ guildId: "guild-1" }),
    } as any;
    const channel = { guildId: "guild-1" } as any;
    const cache = makeGuildCache();
    const result = enrichMessageBulkDelete(messages, channel, cache);
    expect(result).toEqual({
      type: "GuildMessageBulkDelete",
      messages,
      channel,
      guild: { id: "guild-1" },
      guildId: "guild-1",
    });
  });
});
