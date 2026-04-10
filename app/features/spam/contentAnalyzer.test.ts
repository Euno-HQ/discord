import {
  analyzeContent,
  buildEmbedBody,
  buildEmbedText,
  hasLinkInContentOrEmbeds,
} from "./contentAnalyzer";
import { computeVerdict } from "./spamScorer";

/** Helper: run content through the full scoring pipeline */
const getVerdict = (content: string) => computeVerdict(analyzeContent(content));

test("content analysis produces correct tiers for known spam patterns", () => {
  // @everyone alone = +5, which is "none" (threshold is 6 for low)
  // but the old isSpam had threshold 4, so "Hello @everyone" was spam.
  // With new system: "Hello @everyone" = mass_ping(+5) = 5 = none
  // This is intentional — behavioral signals would push it higher for real spammers

  // @everyone + spam keyword = +5 (mass_ping) + 1 (spam_keyword) = 6 => low
  expect(getVerdict("@everyone free nitro join now").tier).not.toBe("none");

  // Multiple spam keywords from different categories
  // poki(nsfw)+deepfake(nsfw)+nudes(nsfw)+free(scam)+nitro(scam) = 5 keywords = 5 points
  // Still below threshold, but with @here it would be 10 points
  expect(getVerdict("@here poki deepfakes nudes free nitro").tier).not.toBe(
    "none",
  );
});

test("content analysis does not flag legitimate messages", () => {
  expect(getVerdict("Hello").tier).toBe("none");
  expect(getVerdict("Hello https://google.com").tier).toBe("none");
  expect(getVerdict("Hello https://google.com discord").tier).toBe("none");

  // Gift card discussion with safe context
  expect(
    getVerdict(
      "Hey guys, I have a project where a user can purchase gift and use gift cards, so how do I store a decrypted gift url`",
    ).tier,
  ).toBe("none");

  // Repeated harmless word
  expect(getVerdict("free free free free free").tier).toBe("none");

  // URL with no spam keywords
  expect(
    getVerdict("https://example.com//w1280$%7Btrend.backdrop_path").tier,
  ).toBe("none");
});

test("content signals are correctly identified", () => {
  const signals = analyzeContent("Check out nitro free gift");
  const names = signals.map((s) => s.name);

  expect(names).toContain("spam_keyword:scam"); // nitro, free, gift
});

test("safe keywords reduce score", () => {
  const signals = analyzeContent(
    "We are hiring! Check https://jobs.example.com for details",
  );
  const safeSignal = signals.find((s) => s.name === "safe_keyword");
  expect(safeSignal).toBeDefined();
  expect(safeSignal!.score).toBe(-10);
});

test("zalgo detection works", () => {
  // Normal text: no zalgo
  expect(
    analyzeContent("Hello world").find((s) => s.name === "zalgo_abuse"),
  ).toBeUndefined();

  // Zalgo text: lots of combining characters
  const zalgo = "H̵̢̧̛̗̘̙̜̝̞̟̠̣̤̥̦̩e̵̢̧̛̗̘̙̜l̵̢̧̛̗̘̙l̵o̵";
  expect(
    analyzeContent(zalgo).find((s) => s.name === "zalgo_abuse"),
  ).toBeDefined();
});

test("mass ping detection", () => {
  const signals = analyzeContent("@everyone @here check this out");
  const pingSignal = signals.find((s) => s.name === "mass_ping");
  expect(pingSignal).toBeDefined();
  expect(pingSignal!.score).toBe(10); // 2 pings * 5
});

// ── Embed content tests ──
// These tests exercise the embed text extraction and content hashing logic
// exported from contentAnalyzer.ts and used by service.ts.

test("embed-only message produces a non-empty content hash", () => {
  const embeds = [
    {
      url: "https://scam.example.com/free-nitro",
      title: "Free Nitro Giveaway",
      description: "Click to claim your reward",
    },
  ];

  // Mirrors: [content.toLowerCase().trim(), embedText].filter(Boolean).join(" ")
  const content = "";
  const embedText = buildEmbedText(embeds);
  const contentHash = [content.toLowerCase().trim(), embedText]
    .filter(Boolean)
    .join(" ");

  expect(contentHash).not.toBe("");
  expect(contentHash).toContain("free nitro giveaway");
});

test("embed title and description keywords are detected by analyzeContent", () => {
  const embeds = [
    {
      url: "https://scam.example.com",
      title: "Claim your free nitro gift now",
      description: "Limited airdrop — verify your account",
      footer: null,
      fields: [],
    },
  ];

  // service.ts passes `content + " " + embedBody` to analyzeContent
  const embedBody = buildEmbedBody(embeds);
  const combinedContent = `${""} ${embedBody}`.trim();

  const signals = analyzeContent(combinedContent);
  const names = signals.map((s) => s.name);

  expect(names).toContain("spam_keyword:scam"); // free, nitro, gift, claim
  expect(names).toContain("spam_keyword:crypto"); // airdrop
  expect(names).toContain("spam_keyword:phishing"); // verify
});

test("hasLink detects links in embed URLs even when message.content is empty", () => {
  const content = "";
  const embeds = [
    {
      url: "https://scam.example.com/free-nitro",
      title: null,
      description: null,
    },
  ];

  expect(hasLinkInContentOrEmbeds(content, embeds)).toBe(true);
});

test("hasLink is false when content has no http and embeds have no url", () => {
  const content = "just a plain message";
  const embeds = [{ url: null, title: "No link here", description: null }];

  expect(hasLinkInContentOrEmbeds(content, embeds)).toBe(false);
});
