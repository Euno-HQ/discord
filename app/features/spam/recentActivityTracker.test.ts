import type { ActivityMap, RecentMessage } from "./recentActivityTracker";
import {
  recordMessage,
  getRecentMessages,
  cleanupTracker,
} from "./recentActivityTracker";

const makeMsg = (overrides: Partial<RecentMessage> = {}): RecentMessage => ({
  messageId: `msg-${Math.random()}`,
  channelId: "ch-1",
  contentHash: "hello",
  timestamp: Date.now(),
  hasLink: false,
  ...overrides,
});

// ── recordMessage ──

test("records a message for a new user", () => {
  const tracker: ActivityMap = new Map();
  recordMessage(tracker, "guild-1", "user-1", makeMsg());
  expect(getRecentMessages(tracker, "guild-1", "user-1")).toHaveLength(1);
});

test("accumulates messages for the same user", () => {
  const tracker: ActivityMap = new Map();
  recordMessage(tracker, "guild-1", "user-1", makeMsg());
  recordMessage(tracker, "guild-1", "user-1", makeMsg());
  recordMessage(tracker, "guild-1", "user-1", makeMsg());
  expect(getRecentMessages(tracker, "guild-1", "user-1")).toHaveLength(3);
});

test("separates users by guild", () => {
  const tracker: ActivityMap = new Map();
  recordMessage(tracker, "guild-1", "user-1", makeMsg());
  recordMessage(tracker, "guild-2", "user-1", makeMsg());
  expect(getRecentMessages(tracker, "guild-1", "user-1")).toHaveLength(1);
  expect(getRecentMessages(tracker, "guild-2", "user-1")).toHaveLength(1);
});

test("separates users by user ID", () => {
  const tracker: ActivityMap = new Map();
  recordMessage(tracker, "guild-1", "user-1", makeMsg());
  recordMessage(tracker, "guild-1", "user-2", makeMsg());
  expect(getRecentMessages(tracker, "guild-1", "user-1")).toHaveLength(1);
  expect(getRecentMessages(tracker, "guild-1", "user-2")).toHaveLength(1);
});

test("caps at 20 messages per user, keeping newest", () => {
  const tracker: ActivityMap = new Map();
  const messages: RecentMessage[] = [];
  for (let i = 0; i < 25; i++) {
    const msg = makeMsg({ messageId: `msg-${i}`, timestamp: 1000 + i });
    messages.push(msg);
    recordMessage(tracker, "guild-1", "user-1", msg);
  }
  const recent = getRecentMessages(tracker, "guild-1", "user-1");
  expect(recent).toHaveLength(20);
  expect(recent[0].messageId).toBe("msg-5");
  expect(recent[19].messageId).toBe("msg-24");
});

// ── getRecentMessages ──

test("returns empty array for unknown user", () => {
  const tracker: ActivityMap = new Map();
  expect(getRecentMessages(tracker, "guild-1", "nobody")).toEqual([]);
});

// ── cleanupTracker ──

test("removes messages older than maxAge", () => {
  const tracker: ActivityMap = new Map();
  const now = Date.now();
  recordMessage(tracker, "g", "u", makeMsg({ timestamp: now - 60000 }));
  recordMessage(tracker, "g", "u", makeMsg({ timestamp: now - 10000 }));
  cleanupTracker(tracker, 30000);
  const msgs = getRecentMessages(tracker, "g", "u");
  expect(msgs).toHaveLength(1);
  expect(msgs[0].timestamp).toBe(now - 10000);
});

test("removes entire entry when all messages expire", () => {
  const tracker: ActivityMap = new Map();
  const now = Date.now();
  recordMessage(tracker, "g", "u", makeMsg({ timestamp: now - 60000 }));
  cleanupTracker(tracker, 30000);
  expect(tracker.size).toBe(0);
});

test("preserves entries with some recent messages", () => {
  const tracker: ActivityMap = new Map();
  const now = Date.now();
  recordMessage(tracker, "g", "u1", makeMsg({ timestamp: now - 60000 }));
  recordMessage(tracker, "g", "u2", makeMsg({ timestamp: now - 5000 }));
  cleanupTracker(tracker, 30000);
  expect(tracker.size).toBe(1);
  expect(getRecentMessages(tracker, "g", "u2")).toHaveLength(1);
});
