/**
 * Content-based spam analysis — pure functions, no Effect.
 * Evolved from app/helpers/isSpam.ts with additional signals.
 */

import type { SpamSignal } from "./spamScorer.ts";

// ── Static keyword lists for content-based spam detection ──

const spamKeywordsByCategory = {
  scam: ["nitro", "steam", "gift", "free", "claim", "reward"],
  nsfw: ["18+", "nudes", "onlyfans", "deepfake", "poki"],
  crypto: ["airdrop", "whitelist", "nft", "mint", "dex"],
  phishing: ["verify", "billing", "suspended", "expired"],
} as const;

type SpamCategory = keyof typeof spamKeywordsByCategory;

const spamKeywords: { pattern: RegExp; category: SpamCategory }[] =
  Object.entries(spamKeywordsByCategory).flatMap(([category, keywords]) =>
    keywords.map((kw) => ({
      pattern: new RegExp(kw, "i"),
      category: category as SpamCategory,
    })),
  );

const safeKeywords = ["forhire", "hiring", "remote", "onsite"];

const spamPings = ["@everyone", "@here"] as const;

/** Count how many spam pings (@everyone, @here) appear in the content */
function getPingCount(content: string): number {
  return spamPings.reduce(
    (sum, ping) => (content.includes(ping) ? sum + 1 : sum),
    0,
  );
}

/** Check if any safe keywords appear (word-boundary matching) */
function hasSafeKeywords(content: string): boolean {
  const words = content.split(/\b/);
  return words.some((w) => safeKeywords.includes(w.toLowerCase()));
}

/**
 * Detect excessive combining diacriticals (zalgo text).
 * Returns true if the message has an abnormal density of combining characters.
 */
function hasZalgoAbuse(content: string): boolean {
  // Match Unicode combining marks using property escape
  const combiningChars = content.match(/\p{M}/gu);
  if (!combiningChars) return false;
  // If combining chars are >20% of content length, it's zalgo
  return combiningChars.length > content.length * 0.2;
}

/** Count unique user mentions (not role or channel mentions) */
function getUserMentionCount(content: string): number {
  const mentions = content.match(/<@!?\d+>/g);
  return mentions ? new Set(mentions).size : 0;
}

// ── Embed extraction & content hashing (pure helpers used by service.ts) ──

export interface EmbedLike {
  url?: string | null;
  title?: string | null;
  description?: string | null;
  footer?: { text?: string | null } | null;
  fields?: { name: string; value: string }[];
}

/**
 * Build a compact text representation of embed URLs, titles, and descriptions.
 * Used for content hashing (duplicate detection).
 */
export function buildEmbedText(embeds: EmbedLike[]): string {
  return embeds
    .map((e) => [e.url, e.title, e.description].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase()
    .trim();
}

/**
 * Build a full text representation of all embed content including footer and fields.
 * Used for content analysis (spam keyword detection).
 */
export function buildEmbedBody(embeds: EmbedLike[]): string {
  return embeds
    .map((e) =>
      [
        e.url,
        e.title,
        e.description,
        e.footer?.text,
        ...(e.fields ?? []).map((f) => `${f.name} ${f.value}`),
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");
}

/**
 * Build a content hash for duplicate detection.
 * Combines normalized message text, embed text, and attachment IDs.
 */
export function buildContentHash(
  content: string,
  embedText: string,
  attachmentIds: string[],
): string {
  const baseContent = [content.toLowerCase().trim(), embedText]
    .filter(Boolean)
    .join(" ");
  const sortedIds = [...attachmentIds].sort().join(",");
  return sortedIds ? `${baseContent}::attachments:${sortedIds}` : baseContent;
}

/**
 * Check if a message or its embeds contain a link.
 */
export function hasLinkInContentOrEmbeds(
  content: string,
  embeds: EmbedLike[],
): boolean {
  return content.includes("http") || embeds.some((e) => e.url != null);
}

/** Analyze message content and return scored signals */
export function analyzeContent(content: string): SpamSignal[] {
  const signals: SpamSignal[] = [];

  // Spam keyword matches
  for (const { pattern, category } of spamKeywords) {
    if (pattern.test(content)) {
      signals.push({
        name: `spam_keyword:${category}`,
        score: 1,
        description: `Spam keyword match (${category})`,
      });
    }
  }

  // @everyone / @here pings
  const pingCount = getPingCount(content);
  if (pingCount > 0) {
    signals.push({
      name: "mass_ping",
      score: pingCount * 5,
      description: `@everyone/@here ping (x${pingCount})`,
    });
  }

  // High mention density
  const mentionCount = getUserMentionCount(content);
  if (mentionCount > 3) {
    signals.push({
      name: "high_mention_density",
      score: 2,
      description: `Mass-mention pattern (${mentionCount} users)`,
    });
  }

  // Zalgo/unicode abuse
  if (hasZalgoAbuse(content)) {
    signals.push({
      name: "zalgo_abuse",
      score: 3,
      description: "Excessive combining diacriticals (zalgo text)",
    });
  }

  // Safe keywords reduce score
  if (hasSafeKeywords(content)) {
    signals.push({
      name: "safe_keyword",
      score: -10,
      description: "Contains safe keyword (hiring etc)",
    });
  }

  return signals;
}
