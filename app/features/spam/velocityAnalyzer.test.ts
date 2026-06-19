import type { RecentMessage } from "./recentActivityTracker";
import {
  analyzeVelocity,
  getPriorDuplicates,
  VELOCITY_TUNING,
} from "./velocityAnalyzer";

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

// ── Scaled velocity signal tests ──

describe("channel_hop_fast scaling", () => {
  // Space messages 3000ms apart so all 15 fit inside the 60s window
  // (furthest message: 15 * 3000 = 45000ms ago, well under 60s)
  function makeHopMessages(channelCount: number): RecentMessage[] {
    const now = Date.now();
    return Array.from({ length: channelCount }, (_, i) =>
      makeMessage({ channelId: `ch-${i}`, timestamp: now - (i + 1) * 3000 }),
    );
  }

  test("3 channels → base score (no bonus)", () => {
    const signals = analyzeVelocity(makeHopMessages(3), "new content");
    const s = signals.find((x) => x.name === "channel_hop_fast");
    expect(s).toBeDefined();
    expect(s!.score).toBe(VELOCITY_TUNING.channelHopFast.base);
  });

  test("5 channels → base + 2", () => {
    const signals = analyzeVelocity(makeHopMessages(5), "new content");
    const s = signals.find((x) => x.name === "channel_hop_fast");
    expect(s).toBeDefined();
    expect(s!.score).toBe(VELOCITY_TUNING.channelHopFast.base + 2);
  });

  test("11 channels → base + 8 (bonusCap)", () => {
    const signals = analyzeVelocity(makeHopMessages(11), "new content");
    const s = signals.find((x) => x.name === "channel_hop_fast");
    expect(s).toBeDefined();
    expect(s!.score).toBe(
      VELOCITY_TUNING.channelHopFast.base +
        VELOCITY_TUNING.channelHopFast.bonusCap,
    );
  });

  test("15 channels → capped at base + bonusCap", () => {
    const signals = analyzeVelocity(makeHopMessages(15), "new content");
    const s = signals.find((x) => x.name === "channel_hop_fast");
    expect(s).toBeDefined();
    expect(s!.score).toBe(
      VELOCITY_TUNING.channelHopFast.base +
        VELOCITY_TUNING.channelHopFast.bonusCap,
    );
  });
});

describe("rapid_fire scaling", () => {
  // Space messages 2s apart so all fit within the 30s window
  function makeRapidMessages(count: number): RecentMessage[] {
    const now = Date.now();
    return Array.from({ length: count }, (_, i) =>
      makeMessage({ contentHash: `msg-${i}`, timestamp: now - i * 2000 }),
    );
  }

  test("5 msgs → base score (no bonus)", () => {
    const signals = analyzeVelocity(makeRapidMessages(5), "new content");
    const s = signals.find((x) => x.name === "rapid_fire");
    expect(s).toBeDefined();
    expect(s!.score).toBe(VELOCITY_TUNING.rapidFire.base);
  });

  test("8 msgs → base + 3", () => {
    const signals = analyzeVelocity(makeRapidMessages(8), "new content");
    const s = signals.find((x) => x.name === "rapid_fire");
    expect(s).toBeDefined();
    expect(s!.score).toBe(VELOCITY_TUNING.rapidFire.base + 3);
  });

  test("10 msgs → base + 5 (bonusCap)", () => {
    const signals = analyzeVelocity(makeRapidMessages(10), "new content");
    const s = signals.find((x) => x.name === "rapid_fire");
    expect(s).toBeDefined();
    expect(s!.score).toBe(
      VELOCITY_TUNING.rapidFire.base + VELOCITY_TUNING.rapidFire.bonusCap,
    );
  });

  test("14 msgs → capped at base + bonusCap", () => {
    const signals = analyzeVelocity(makeRapidMessages(14), "new content");
    const s = signals.find((x) => x.name === "rapid_fire");
    expect(s).toBeDefined();
    expect(s!.score).toBe(
      VELOCITY_TUNING.rapidFire.base + VELOCITY_TUNING.rapidFire.bonusCap,
    );
  });
});

describe("channel_hop_slow scaling", () => {
  // Make messages spread over 5 minutes (not 60s), so channelsIn60s < 3
  function makeSlowHopMessages(channelCount: number): RecentMessage[] {
    const now = Date.now();
    return Array.from({ length: channelCount }, (_, i) =>
      makeMessage({
        channelId: `ch-${i}`,
        // spread over ~4 minutes so they are within 5m but outside 60s
        timestamp: now - 70000 - i * 15000,
      }),
    );
  }

  test("5 channels in 5m (slow) → base score", () => {
    const signals = analyzeVelocity(makeSlowHopMessages(5), "new content");
    const s = signals.find((x) => x.name === "channel_hop_slow");
    expect(s).toBeDefined();
    expect(s!.score).toBe(VELOCITY_TUNING.channelHopSlow.base);
  });

  test("9 channels in 5m (slow) → base + 4 (capped)", () => {
    const signals = analyzeVelocity(makeSlowHopMessages(9), "new content");
    const s = signals.find((x) => x.name === "channel_hop_slow");
    expect(s).toBeDefined();
    expect(s!.score).toBe(
      VELOCITY_TUNING.channelHopSlow.base +
        VELOCITY_TUNING.channelHopSlow.bonusCap,
    );
  });
});

describe("attachment_burst signal", () => {
  test("fires when a velocity signal is present (channel-hop + 2 attachments)", () => {
    const now = Date.now();
    const messages = [
      makeMessage({ channelId: "ch-1", timestamp: now - 10000 }),
      makeMessage({ channelId: "ch-2", timestamp: now - 5000 }),
      makeMessage({ channelId: "ch-3", timestamp: now - 1000 }),
    ];
    const signals = analyzeVelocity(messages, "new content", 2);
    expect(signals.find((s) => s.name === "channel_hop_fast")).toBeDefined();
    const burst = signals.find((s) => s.name === "attachment_burst");
    expect(burst).toBeDefined();
    expect(burst!.score).toBe(2);
  });

  test("does NOT fire when no velocity signal is present (lone message with attachments)", () => {
    const signals = analyzeVelocity([], "new content", 3);
    expect(signals.find((s) => s.name === "attachment_burst")).toBeUndefined();
  });

  test("attachment_burst score is capped at bonusCap", () => {
    const now = Date.now();
    const messages = [
      makeMessage({ channelId: "ch-1", timestamp: now - 10000 }),
      makeMessage({ channelId: "ch-2", timestamp: now - 5000 }),
      makeMessage({ channelId: "ch-3", timestamp: now - 1000 }),
    ];
    // 10 attachments, bonusCap is 4
    const signals = analyzeVelocity(messages, "new content", 10);
    const burst = signals.find((s) => s.name === "attachment_burst");
    expect(burst).toBeDefined();
    expect(burst!.score).toBe(VELOCITY_TUNING.attachmentBurst.bonusCap);
  });

  test("does NOT appear on cross_channel_spam path (early return)", () => {
    const now = Date.now();
    const hash = "spam content";
    const messages = [
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
    // cross_channel_spam should fire and early-return — no attachment_burst
    const signals = analyzeVelocity(messages, hash, 3);
    expect(signals.find((s) => s.name === "cross_channel_spam")).toBeDefined();
    expect(signals).toHaveLength(1);
    expect(signals.find((s) => s.name === "attachment_burst")).toBeUndefined();
  });
});

describe("scenario fixtures (velocity-only totals)", () => {
  test("Scenario C: 15 channels/60s + 14 msgs/30s, 0 attachments → sum 20", () => {
    const now = Date.now();
    // 15 unique channels in 60s, varied content, 14 msgs in 30s
    const messages = Array.from({ length: 14 }, (_, i) =>
      makeMessage({
        channelId: `ch-${i % 15}`,
        contentHash: `unique-${i}`,
        timestamp: now - (i + 1) * 2000, // within 30s
      }),
    );
    // Add one more unique channel to reach 15 distinct (i%15 covers 0–13 = 14 channels already)
    // With 14 msgs and channelId ch-0..ch-13, we have 14 channels; need 15
    const extra = makeMessage({
      channelId: "ch-14",
      contentHash: "unique-extra",
      timestamp: now - 1000,
    });
    const allMessages = [...messages, extra];
    const signals = analyzeVelocity(allMessages, "new content", 0);
    const hopFast = signals.find((s) => s.name === "channel_hop_fast");
    const rapid = signals.find((s) => s.name === "rapid_fire");
    expect(hopFast).toBeDefined();
    expect(rapid).toBeDefined();
    // channel_hop_fast: scaledScore(4, 15, 3, 1, 8) = 4 + min(12, 8) = 12
    expect(hopFast!.score).toBe(12);
    // rapid_fire: scaledScore(3, 15, 5, 1, 5) = 3 + min(10, 5) = 8
    expect(rapid!.score).toBe(8);
    const velocitySum = signals
      .filter((s) => ["channel_hop_fast", "rapid_fire"].includes(s.name))
      .reduce((acc, s) => acc + s.score, 0);
    expect(velocitySum).toBe(20);
  });

  test("Scenario E: 5 channels/60s + 5 msgs/30s → velocity sum 9", () => {
    const now = Date.now();
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({
        channelId: `ch-${i}`,
        contentHash: `unique-${i}`,
        timestamp: now - (i + 1) * 4000, // within 30s (i=4 → 20s ago)
      }),
    );
    const signals = analyzeVelocity(messages, "new content", 0);
    const hopFast = signals.find((s) => s.name === "channel_hop_fast");
    const rapid = signals.find((s) => s.name === "rapid_fire");
    expect(hopFast).toBeDefined();
    expect(rapid).toBeDefined();
    // channel_hop_fast: scaledScore(4, 5, 3, 1, 8) = 4 + 2 = 6
    expect(hopFast!.score).toBe(6);
    // rapid_fire: scaledScore(3, 5, 5, 1, 5) = 3 + 0 = 3
    expect(rapid!.score).toBe(3);
    const velocitySum = signals
      .filter((s) => ["channel_hop_fast", "rapid_fire"].includes(s.name))
      .reduce((acc, s) => acc + s.score, 0);
    expect(velocitySum).toBe(9);
  });
});
