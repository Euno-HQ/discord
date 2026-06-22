import { resolveReactjiEmoji } from "./reactjiEmoji";

interface GuildEmoji {
  name: string | null;
  id: string;
  animated: boolean;
}

const noGuildEmoji: GuildEmoji[] = [];

test("accepts a literal unicode emoji", () => {
  expect(resolveReactjiEmoji("👍", noGuildEmoji)).toEqual({
    ok: true,
    value: "👍",
  });
});

test("trims surrounding whitespace from a unicode emoji", () => {
  expect(resolveReactjiEmoji("  🔥 ", noGuildEmoji)).toEqual({
    ok: true,
    value: "🔥",
  });
});

test("accepts a skin-tone modified emoji node-emoji doesn't know", () => {
  expect(resolveReactjiEmoji("👍🏽", noGuildEmoji)).toEqual({
    ok: true,
    value: "👍🏽",
  });
});

test("accepts a custom-emoji mention verbatim", () => {
  expect(resolveReactjiEmoji("<:partyblob:123>", noGuildEmoji)).toEqual({
    ok: true,
    value: "<:partyblob:123>",
  });
});

test("accepts an animated custom-emoji mention verbatim", () => {
  expect(resolveReactjiEmoji("<a:dance:456>", noGuildEmoji)).toEqual({
    ok: true,
    value: "<a:dance:456>",
  });
});

test("resolves a bare guild-emoji name to its mention", () => {
  const guild: GuildEmoji[] = [
    { name: "partyblob", id: "999", animated: false },
  ];
  expect(resolveReactjiEmoji("partyblob", guild)).toEqual({
    ok: true,
    value: "<:partyblob:999>",
  });
});

test("resolves a bare animated guild-emoji name to its animated mention", () => {
  const guild: GuildEmoji[] = [{ name: "dance", id: "777", animated: true }];
  expect(resolveReactjiEmoji("dance", guild)).toEqual({
    ok: true,
    value: "<a:dance:777>",
  });
});

test("guild custom emoji takes precedence over a same-named unicode shortcode", () => {
  const guild: GuildEmoji[] = [{ name: "fire", id: "555", animated: false }];
  expect(resolveReactjiEmoji("fire", guild)).toEqual({
    ok: true,
    value: "<:fire:555>",
  });
});

test("converts a standard shortcode with colons to unicode", () => {
  expect(resolveReactjiEmoji(":smile:", noGuildEmoji)).toEqual({
    ok: true,
    value: "😄",
  });
});

test("converts a standard shortcode without colons to unicode", () => {
  expect(resolveReactjiEmoji("smile", noGuildEmoji)).toEqual({
    ok: true,
    value: "😄",
  });
});

test("converts the Discord-specific thumbsup alias node-emoji lacks", () => {
  expect(resolveReactjiEmoji("thumbsup", noGuildEmoji)).toEqual({
    ok: true,
    value: "👍",
  });
});

test("converts :thumbsup: (the issue's example) to unicode", () => {
  expect(resolveReactjiEmoji(":thumbsup:", noGuildEmoji)).toEqual({
    ok: true,
    value: "👍",
  });
});

test("rejects unrecognized text with no match", () => {
  const result = resolveReactjiEmoji("notanemoji", noGuildEmoji);
  expect(result.ok).toBe(false);
});

test("rejects empty / whitespace-only input", () => {
  expect(resolveReactjiEmoji("   ", noGuildEmoji).ok).toBe(false);
});

test("rejects an emoji glued to trailing text (would be a dead config)", () => {
  expect(resolveReactjiEmoji("👍hello", noGuildEmoji).ok).toBe(false);
});
