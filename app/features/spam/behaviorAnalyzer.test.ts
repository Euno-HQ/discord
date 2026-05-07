import { analyzeBehavior } from "./behaviorAnalyzer";

const ONE_DAY = 24 * 60 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

function makeArgs(overrides: {
  accountAgeMs?: number;
  joinedAgoMs?: number;
}) {
  const now = Date.now();
  const accountAge = overrides.accountAgeMs ?? 365 * ONE_DAY;
  const joinedAgo = overrides.joinedAgoMs ?? 365 * ONE_DAY;
  const message = {
    author: { createdTimestamp: now - accountAge },
  } as unknown as Parameters<typeof analyzeBehavior>[0];
  const member = {
    joinedTimestamp: now - joinedAgo,
  } as unknown as Parameters<typeof analyzeBehavior>[1];
  return { message, member };
}

// ── Account age signals ──

test("account < 1 day scores 2", () => {
  const { message, member } = makeArgs({ accountAgeMs: 12 * ONE_HOUR });
  const signals = analyzeBehavior(message, member);
  const signal = signals.find((s) => s.name === "account_age_lt_1d");
  expect(signal).toBeDefined();
  expect(signal!.score).toBe(2);
});

test("account 1-7 days scores 2", () => {
  const { message, member } = makeArgs({ accountAgeMs: 3 * ONE_DAY });
  const signals = analyzeBehavior(message, member);
  const signal = signals.find((s) => s.name === "account_age_lt_7d");
  expect(signal).toBeDefined();
  expect(signal!.score).toBe(2);
});

test("account 7-30 days scores 1", () => {
  const { message, member } = makeArgs({ accountAgeMs: 15 * ONE_DAY });
  const signals = analyzeBehavior(message, member);
  const signal = signals.find((s) => s.name === "account_age_lt_30d");
  expect(signal).toBeDefined();
  expect(signal!.score).toBe(1);
});

test("account > 30 days produces no account age signal", () => {
  const { message, member } = makeArgs({ accountAgeMs: 60 * ONE_DAY });
  const signals = analyzeBehavior(message, member);
  expect(signals.find((s) => s.name.startsWith("account_age"))).toBeUndefined();
});

// ── Server tenure signals ──

test("joined < 1 hour scores 2", () => {
  const { message, member } = makeArgs({ joinedAgoMs: 30 * 60 * 1000 });
  const signals = analyzeBehavior(message, member);
  const signal = signals.find((s) => s.name === "server_tenure_lt_1h");
  expect(signal).toBeDefined();
  expect(signal!.score).toBe(2);
});

test("joined 1-24 hours scores 2", () => {
  const { message, member } = makeArgs({ joinedAgoMs: 12 * ONE_HOUR });
  const signals = analyzeBehavior(message, member);
  const signal = signals.find((s) => s.name === "server_tenure_lt_24h");
  expect(signal).toBeDefined();
  expect(signal!.score).toBe(2);
});

test("joined 1-7 days scores 1", () => {
  const { message, member } = makeArgs({ joinedAgoMs: 3 * ONE_DAY });
  const signals = analyzeBehavior(message, member);
  const signal = signals.find((s) => s.name === "server_tenure_lt_7d");
  expect(signal).toBeDefined();
  expect(signal!.score).toBe(1);
});

test("joined > 7 days produces no tenure signal", () => {
  const { message, member } = makeArgs({ joinedAgoMs: 30 * ONE_DAY });
  const signals = analyzeBehavior(message, member);
  expect(signals.find((s) => s.name.startsWith("server_tenure"))).toBeUndefined();
});

test("null joinedTimestamp produces no tenure signal", () => {
  const { message } = makeArgs({});
  const member = { joinedTimestamp: null } as unknown as Parameters<typeof analyzeBehavior>[1];
  const signals = analyzeBehavior(message, member);
  expect(signals.find((s) => s.name.startsWith("server_tenure"))).toBeUndefined();
});

// ── Combined ──

test("new account + just joined produces both signals", () => {
  const { message, member } = makeArgs({
    accountAgeMs: 6 * ONE_HOUR,
    joinedAgoMs: 10 * 60 * 1000,
  });
  const signals = analyzeBehavior(message, member);
  expect(signals).toHaveLength(2);
  expect(signals.find((s) => s.name === "account_age_lt_1d")).toBeDefined();
  expect(signals.find((s) => s.name === "server_tenure_lt_1h")).toBeDefined();
});

test("old account + old member produces no signals", () => {
  const { message, member } = makeArgs({
    accountAgeMs: 365 * ONE_DAY,
    joinedAgoMs: 60 * ONE_DAY,
  });
  const signals = analyzeBehavior(message, member);
  expect(signals).toHaveLength(0);
});
