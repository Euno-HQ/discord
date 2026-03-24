import {
  buildContentHash,
  buildEmbedBody,
  buildEmbedText,
  hasLinkInContentOrEmbeds,
} from "./contentAnalyzer";
import { CROSS_GUILD_SPAM_THRESHOLD } from "./spamResponseHandler";
import { AUTO_KICK_THRESHOLD } from "./spamScorer";

// ── Cross-guild spam threshold ──
// The threshold is a constant used by checkCrossGuildSpam, which is deeply
// entangled with Discord API calls. We test the threshold value and document
// the decision boundary here so that any changes are intentional.

test("CROSS_GUILD_SPAM_THRESHOLD is 3 (account flagged in 3+ guilds triggers escalation)", () => {
  expect(CROSS_GUILD_SPAM_THRESHOLD).toBe(3);
});

test("cross-guild threshold is lower than auto-kick threshold (escalates before kick)", () => {
  // Cross-guild timeout fires when flagged across enough guilds.
  // Auto-kick fires on repeated high-tier reports within one guild.
  // The cross-guild check should be reachable before a single-guild kick.
  expect(CROSS_GUILD_SPAM_THRESHOLD).toBeLessThanOrEqual(AUTO_KICK_THRESHOLD);
});

test("cross-guild threshold requires at least 2 guilds (never triggers on single-guild activity)", () => {
  expect(CROSS_GUILD_SPAM_THRESHOLD).toBeGreaterThan(1);
});

// ── Content hash construction ──

test("buildContentHash normalizes text content to lowercase", () => {
  const hash = buildContentHash("HELLO WORLD", "", []);
  expect(hash).toBe("hello world");
});

test("buildContentHash trims whitespace from text content", () => {
  const hash = buildContentHash("  hello  ", "", []);
  expect(hash).toBe("hello");
});

test("buildContentHash combines text content and embed text", () => {
  const hash = buildContentHash("hello", "embed text here", []);
  expect(hash).toBe("hello embed text here");
});

test("buildContentHash includes embed text when message content is empty", () => {
  const hash = buildContentHash("", "free nitro giveaway", []);
  expect(hash).toBe("free nitro giveaway");
});

test("buildContentHash appends sorted attachment IDs", () => {
  const hash = buildContentHash("hello", "", ["id-b", "id-a"]);
  expect(hash).toBe("hello::attachments:id-a,id-b");
});

test("buildContentHash omits attachment suffix when no attachments", () => {
  const hash = buildContentHash("hello", "", []);
  expect(hash).not.toContain("::attachments:");
});

test("buildContentHash produces unique hashes for different attachments with empty content", () => {
  const hash1 = buildContentHash("", "", ["attachment-1"]);
  const hash2 = buildContentHash("", "", ["attachment-2"]);
  expect(hash1).not.toBe(hash2);
});

test("buildContentHash produces identical hashes for same content regardless of attachment order", () => {
  const hash1 = buildContentHash("hello", "", ["id-a", "id-b"]);
  const hash2 = buildContentHash("hello", "", ["id-b", "id-a"]);
  expect(hash1).toBe(hash2);
});

test("buildContentHash combines all three inputs", () => {
  const hash = buildContentHash("hello", "embed", ["att-1"]);
  expect(hash).toBe("hello embed::attachments:att-1");
});

test("buildContentHash for empty content with only attachments", () => {
  const hash = buildContentHash("", "", ["att-1"]);
  expect(hash).toBe("::attachments:att-1");
});

// ── buildEmbedText ──

test("buildEmbedText extracts url, title, description and lowercases", () => {
  const text = buildEmbedText([
    {
      url: "https://example.com",
      title: "My Title",
      description: "Some Description",
    },
  ]);
  expect(text).toBe("https://example.com my title some description");
});

test("buildEmbedText filters out null/undefined fields", () => {
  const text = buildEmbedText([
    { url: null, title: "Title Only", description: null },
  ]);
  expect(text).toBe("title only");
});

test("buildEmbedText joins multiple embeds", () => {
  const text = buildEmbedText([
    { url: null, title: "First", description: null },
    { url: null, title: "Second", description: null },
  ]);
  expect(text).toBe("first second");
});

test("buildEmbedText returns empty string for no embeds", () => {
  expect(buildEmbedText([])).toBe("");
});

// ── buildEmbedBody ──

test("buildEmbedBody includes footer and fields", () => {
  const body = buildEmbedBody([
    {
      url: "https://example.com",
      title: "Title",
      description: "Desc",
      footer: { text: "Footer text" },
      fields: [{ name: "Field1", value: "Value1" }],
    },
  ]);
  expect(body).toContain("Footer text");
  expect(body).toContain("Field1 Value1");
});

test("buildEmbedBody handles missing footer and fields", () => {
  const body = buildEmbedBody([
    { url: null, title: "Title", description: null },
  ]);
  expect(body).toBe("Title");
});

// ── hasLinkInContentOrEmbeds ──

test("hasLinkInContentOrEmbeds detects http in content", () => {
  expect(hasLinkInContentOrEmbeds("check https://example.com", [])).toBe(true);
});

test("hasLinkInContentOrEmbeds detects url in embeds", () => {
  expect(
    hasLinkInContentOrEmbeds("no link", [{ url: "https://example.com" }]),
  ).toBe(true);
});

test("hasLinkInContentOrEmbeds returns false when no links anywhere", () => {
  expect(
    hasLinkInContentOrEmbeds("plain text", [{ url: null, title: "embed" }]),
  ).toBe(false);
});
