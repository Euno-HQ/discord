import type { Message } from "discord.js";
import { Effect } from "effect";

import { escapeDisruptiveContent, getMessageStats } from "./discord";

test("escapeDisruptiveContent", () => {
  expect(escapeDisruptiveContent("https://example.com")).toBe(
    "<https://example.com>",
  );
  expect(escapeDisruptiveContent("discord.gg/butts")).toBe(
    "<discord.gg/butts>",
  );
  expect(
    escapeDisruptiveContent("test stuff discord.gg/butts wrapped around"),
  ).toBe("test stuff <discord.gg/butts> wrapped around");
  expect(
    escapeDisruptiveContent(
      "some dumb text https://example.com with a link and text",
    ),
  ).toBe("some dumb text <https://example.com> with a link and text");
  expect(escapeDisruptiveContent("some dumb text https://example.com")).toBe(
    "some dumb text <https://example.com>",
  );
});

test("getMessageStats returns zeroed content stats when content is unavailable", () => {
  // Discord withholds message content (no Message Content intent): we still
  // want the row, with content-derived counts zeroed.
  const msg = {
    id: "123",
    partial: false,
    content: "",
    reactions: { cache: { size: 2 } },
    createdTimestamp: 1700000000000,
  } as unknown as Message;

  expect(Effect.runSync(getMessageStats(msg))).toEqual({
    char_count: 0,
    word_count: 0,
    code_stats: [],
    link_stats: [],
    react_count: 2,
    sent_at: 1700000000000,
  });
});
