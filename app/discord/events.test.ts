import { describe, expect, test } from "vitest";

import {
  isGuildMessageEvent,
  type GuildBanAddEvent,
  type GuildMemberMessage,
  type GuildMessageBulkDelete,
  type GuildMessageDelete,
} from "./events";

describe("isGuildMessageEvent", () => {
  test("returns true for GuildMemberMessage", () => {
    const event = { type: "GuildMemberMessage" } as GuildMemberMessage;
    expect(isGuildMessageEvent(event)).toBe(true);
  });

  test("returns true for GuildMessageDelete", () => {
    const event = { type: "GuildMessageDelete" } as GuildMessageDelete;
    expect(isGuildMessageEvent(event)).toBe(true);
  });

  test("returns true for GuildMessageBulkDelete", () => {
    const event = { type: "GuildMessageBulkDelete" } as GuildMessageBulkDelete;
    expect(isGuildMessageEvent(event)).toBe(true);
  });

  test("returns false for GuildBanAdd", () => {
    const event = { type: "GuildBanAdd" } as GuildBanAddEvent;
    expect(isGuildMessageEvent(event)).toBe(false);
  });
});
