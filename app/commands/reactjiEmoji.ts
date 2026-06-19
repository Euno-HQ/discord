/**
 * Reactji emoji input resolution — pure function, no Discord/Effect deps.
 *
 * The reactji channeler keys configs on the reaction's *actual* identifier:
 * a custom-emoji mention (`<:name:id>` / `<a:name:id>`) or, for standard
 * emoji, the unicode character (`reaction.emoji.name`, e.g. `👍`). An admin
 * who types a shortcode (`thumbsup` / `:thumbsup:`) or arbitrary text would
 * otherwise store a value that can never match — a silently dead config (#371).
 *
 * This resolver normalizes input to a storable, matchable value or rejects it.
 */

import { get } from "node-emoji";

export interface GuildEmojiLike {
  name: string | null;
  id: string;
  animated: boolean;
}

export type EmojiResolution =
  | { ok: true; value: string }
  | { ok: false; error: string };

const CUSTOM_MENTION = /^<a?:\w+:\d+>$/;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * Discord exposes these shortcodes but node-emoji's dataset maps the same
 * glyphs to `+1` / `-1` only, so it can't resolve them. Patch the gap.
 */
const DISCORD_ALIASES: Record<string, string> = {
  thumbsup: "👍",
  thumbsdown: "👎",
};

const REJECT =
  "That doesn't look like an emoji. Paste the actual emoji (e.g. 👍) or a custom server emoji, not its name.";

export function resolveReactjiEmoji(
  input: string,
  guildEmojis: GuildEmojiLike[],
): EmojiResolution {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Please provide an emoji." };
  }

  // 1. Fully-formed custom-emoji mention — already matchable, store verbatim.
  if (CUSTOM_MENTION.test(trimmed)) {
    return { ok: true, value: trimmed };
  }

  // 2. Literal unicode emoji (incl. skin tones / sequences node-emoji misses).
  //    Exclude ASCII letters so "👍hello" can't create a never-matching config.
  if (PICTOGRAPHIC.test(trimmed) && !/[A-Za-z]/.test(trimmed)) {
    return { ok: true, value: trimmed };
  }

  // 3. Shortcode / name path — strip optional surrounding colons.
  const key = trimmed.replace(/^:|:$/g, "").toLowerCase();

  // 3a. A custom server emoji by name wins (most specific to this guild).
  const guildEmoji = guildEmojis.find(
    (e) => e.name && e.name.toLowerCase() === key,
  );
  if (guildEmoji) {
    return {
      ok: true,
      value: `<${guildEmoji.animated ? "a" : ""}:${guildEmoji.name}:${guildEmoji.id}>`,
    };
  }

  // 3b. Standard emoji shortcode via node-emoji.
  const fromNodeEmoji = get(key);
  if (fromNodeEmoji) {
    return { ok: true, value: fromNodeEmoji };
  }

  // 3c. Discord-specific aliases node-emoji's dataset omits.
  if (DISCORD_ALIASES[key]) {
    return { ok: true, value: DISCORD_ALIASES[key] };
  }

  return { ok: false, error: REJECT };
}
