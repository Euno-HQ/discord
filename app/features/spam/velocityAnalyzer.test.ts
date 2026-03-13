import type { RecentMessage } from "./recentActivityTracker";
import { analyzeVelocity, getPriorDuplicates } from "./velocityAnalyzer";

const makeMessage = (
  overrides: Partial<RecentMessage> = {},
): RecentMessage => ({
  messageId: `msg-${Math.random()}`,
  channelId: "channel-1",
  contentHash: "hello world",
  timestamp: Date.now(),
  hasLink: false,
  ...overrides,
});

test("detects channel hopping (3+ channels in 60 seconds)", () => {
  const now = Date.now();
  const messages: RecentMessage[] = [
    makeMessage({ channelId: "ch-1", timestamp: now - 10000 }),
    makeMessage({ channelId: "ch-2", timestamp: now - 5000 }),
    makeMessage({ channelId: "ch-3", timestamp: now - 1000 }),
  ];

  const signals = analyzeVelocity(messages, "new content");
  const hopSignal = signals.find((s) => s.name === "channel_hop_fast");
  expect(hopSignal).toBeDefined();
  expect(hopSignal!.score).toBe(4);
});

test("does not flag normal channel usage", () => {
  const now = Date.now();
  const messages: RecentMessage[] = [
    makeMessage({ channelId: "ch-1", timestamp: now - 10000 }),
    makeMessage({ channelId: "ch-2", timestamp: now - 5000 }),
  ];

  const signals = analyzeVelocity(messages, "new content");
  expect(signals.find((s) => s.name === "channel_hop_fast")).toBeUndefined();
});

test("detects duplicate messages", () => {
  const now = Date.now();
  const hash = "same content hash";
  const messages: RecentMessage[] = [
    makeMessage({ contentHash: hash, timestamp: now - 30000 }),
    makeMessage({ contentHash: hash, timestamp: now - 15000 }),
  ];

  const signals = analyzeVelocity(messages, hash);
  const dupSignal = signals.find((s) => s.name === "duplicate_messages");
  expect(dupSignal).toBeDefined();
  expect(dupSignal!.score).toBe(5);
});

test("detects rapid-fire messaging", () => {
  const now = Date.now();
  const messages: RecentMessage[] = Array.from({ length: 5 }, (_, i) =>
    makeMessage({ timestamp: now - i * 5000, contentHash: `msg-${i}` }),
  );

  const signals = analyzeVelocity(messages, "new content");
  const rapidSignal = signals.find((s) => s.name === "rapid_fire");
  expect(rapidSignal).toBeDefined();
  expect(rapidSignal!.score).toBe(3);
});

test("does not flag normal messaging pace", () => {
  const now = Date.now();
  const messages: RecentMessage[] = [
    makeMessage({ timestamp: now - 60000, contentHash: "a" }),
    makeMessage({ timestamp: now - 45000, contentHash: "b" }),
  ];

  const signals = analyzeVelocity(messages, "new content");
  expect(signals.find((s) => s.name === "rapid_fire")).toBeUndefined();
  expect(signals.find((s) => s.name === "duplicate_messages")).toBeUndefined();
});

test("detects cross-channel duplicate spam", () => {
  const now = Date.now();
  const hash = "spam content";
  const messages: RecentMessage[] = [
    makeMessage({
      contentHash: hash,
      channelId: "ch-1",
      timestamp: now - 10000,
    }),
    makeMessage({
      contentHash: hash,
      channelId: "ch-2",
      timestamp: now - 20000,
    }),
    makeMessage({
      contentHash: hash,
      channelId: "ch-3",
      timestamp: now - 30000,
    }),
  ];

  const signals = analyzeVelocity(messages, hash);
  const crossChannelSignal = signals.find(
    (s) => s.name === "cross_channel_spam",
  );
  expect(crossChannelSignal).toBeDefined();
  expect(crossChannelSignal!.score).toBe(15);

  // Should not also flag individual duplicate_messages or channel_hop
  expect(signals.find((s) => s.name === "duplicate_messages")).toBeUndefined();
  expect(signals.find((s) => s.name === "channel_hop_fast")).toBeUndefined();
});

test("should not flag duplicate messages when empty content but different attachments", () => {
  const now = Date.now();
  // Simulate two messages with empty text but different attachments.
  // In the fixed service.ts, each gets a unique hash like "::attachments:<id>".
  const hash1 = "::attachments:attachment-id-1";
  const hash2 = "::attachments:attachment-id-2";
  const messages: RecentMessage[] = [
    makeMessage({ contentHash: hash1, timestamp: now - 30000 }),
    makeMessage({ contentHash: hash2, timestamp: now - 15000 }),
  ];

  // Current message also has a unique attachment hash
  const signals = analyzeVelocity(messages, "::attachments:attachment-id-3");
  expect(signals.find((s) => s.name === "duplicate_messages")).toBeUndefined();
  expect(signals.find((s) => s.name === "cross_channel_spam")).toBeUndefined();
});

test("does not flag cross-channel spam if content differs", () => {
  const now = Date.now();
  const messages: RecentMessage[] = [
    makeMessage({
      contentHash: "msg1",
      channelId: "ch-1",
      timestamp: now - 10000,
    }),
    makeMessage({
      contentHash: "msg2",
      channelId: "ch-2",
      timestamp: now - 20000,
    }),
    makeMessage({
      contentHash: "msg3",
      channelId: "ch-3",
      timestamp: now - 30000,
    }),
  ];

  const signals = analyzeVelocity(messages, "new content");
  expect(signals.find((s) => s.name === "cross_channel_spam")).toBeUndefined();
});

// ── getPriorDuplicates tests ──

test("getPriorDuplicates returns earlier messages with the same hash", () => {
  const now = Date.now();
  const hash = "spam content";
  const currentId = "msg-current";
  const messages = [
    makeMessage({
      messageId: "msg-1",
      contentHash: hash,
      timestamp: now - 60000,
    }),
    makeMessage({
      messageId: "msg-2",
      contentHash: hash,
      timestamp: now - 30000,
    }),
    makeMessage({ messageId: currentId, contentHash: hash, timestamp: now }),
  ];

  const priors = getPriorDuplicates(messages, currentId, hash);
  expect(priors).toHaveLength(2);
  expect(priors.map((m) => m.messageId)).toEqual(
    expect.arrayContaining(["msg-1", "msg-2"]),
  );
  // Should not include the current message
  expect(priors.find((m) => m.messageId === currentId)).toBeUndefined();
});

test("getPriorDuplicates excludes messages with a different hash", () => {
  const now = Date.now();
  const hash = "spam content";
  const currentId = "msg-current";
  const messages = [
    makeMessage({
      messageId: "msg-unrelated",
      contentHash: "other content",
      timestamp: now - 10000,
    }),
    makeMessage({ messageId: currentId, contentHash: hash, timestamp: now }),
  ];

  const priors = getPriorDuplicates(messages, currentId, hash);
  expect(priors).toHaveLength(0);
});

test("getPriorDuplicates excludes messages outside the time window", () => {
  const now = Date.now();
  const hash = "spam content";
  const currentId = "msg-current";
  const FIVE_MIN = 5 * 60 * 1000;
  const messages = [
    // Just outside the window
    makeMessage({
      messageId: "msg-old",
      contentHash: hash,
      timestamp: now - FIVE_MIN - 1000,
    }),
    // Inside the window
    makeMessage({
      messageId: "msg-recent",
      contentHash: hash,
      timestamp: now - FIVE_MIN + 1000,
    }),
    makeMessage({ messageId: currentId, contentHash: hash, timestamp: now }),
  ];

  const priors = getPriorDuplicates(messages, currentId, hash);
  expect(priors).toHaveLength(1);
  expect(priors[0].messageId).toBe("msg-recent");
});

test("getPriorDuplicates returns empty array when no prior duplicates exist", () => {
  const now = Date.now();
  const hash = "unique content";
  const currentId = "msg-current";
  const messages = [
    makeMessage({ messageId: currentId, contentHash: hash, timestamp: now }),
  ];

  const priors = getPriorDuplicates(messages, currentId, hash);
  expect(priors).toHaveLength(0);
});

test("getPriorDuplicates respects a custom window", () => {
  const now = Date.now();
  const hash = "spam content";
  const currentId = "msg-current";
  const messages = [
    makeMessage({
      messageId: "msg-1",
      contentHash: hash,
      timestamp: now - 90000,
    }), // 90s ago
    makeMessage({
      messageId: "msg-2",
      contentHash: hash,
      timestamp: now - 30000,
    }), // 30s ago
    makeMessage({ messageId: currentId, contentHash: hash, timestamp: now }),
  ];

  // 60-second window: only msg-2 should be included
  const priors = getPriorDuplicates(messages, currentId, hash, 60000);
  expect(priors).toHaveLength(1);
  expect(priors[0].messageId).toBe("msg-2");
});
