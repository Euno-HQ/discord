import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import type { IFeatureFlagService } from "#~/effects/featureFlags";

import { analyzeVelocity } from "./velocityAnalyzer";
import { clearVelocityFlagCache, gatedVelocitySignals } from "./velocityGate";

const makeFlags = (enabled: boolean, calls = { n: 0 }): IFeatureFlagService =>
  ({
    isPostHogEnabled: () => {
      calls.n += 1;
      return Effect.succeed(enabled);
    },
    getPostHogValue: () => Effect.die("unused"),
  }) as unknown as IFeatureFlagService;

const NOW = 1_000_000;
const messages = [
  {
    messageId: "1",
    channelId: "c",
    contentHash: "h",
    timestamp: NOW,
    hasLink: false,
  },
  {
    messageId: "2",
    channelId: "c",
    contentHash: "h",
    timestamp: NOW,
    hasLink: false,
  },
];

afterEach(() => clearVelocityFlagCache());

describe("gatedVelocitySignals", () => {
  test("returns analyzeVelocity output when the flag is enabled", async () => {
    const flags = makeFlags(true);
    const result = await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", 0, { now: () => NOW }),
    );
    expect(result).toEqual(analyzeVelocity(messages, "h"));
  });

  test("returns [] when the flag is disabled", async () => {
    const flags = makeFlags(false);
    const result = await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", 0, { now: () => NOW }),
    );
    expect(result).toEqual([]);
  });

  test("caches the flag value within the TTL (one lookup)", async () => {
    const calls = { n: 0 };
    const flags = makeFlags(true, calls);
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", 0, {
        now: () => NOW,
        ttlMs: 60_000,
      }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", 0, {
        now: () => NOW + 30_000,
        ttlMs: 60_000,
      }),
    );
    expect(calls.n).toBe(1);
  });

  test("re-checks after the TTL expires", async () => {
    const calls = { n: 0 };
    const flags = makeFlags(true, calls);
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", 0, {
        now: () => NOW,
        ttlMs: 60_000,
      }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", 0, {
        now: () => NOW + 61_000,
        ttlMs: 60_000,
      }),
    );
    expect(calls.n).toBe(2);
  });

  test("caches per guild — one guild's value does not serve another", async () => {
    const calls = { n: 0 };
    const flags = makeFlags(true, calls);
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", 0, { now: () => NOW }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g2", messages, "h", 0, { now: () => NOW }),
    );
    expect(calls.n).toBe(2);
  });

  test("forwards attachmentCount — channel-hop + attachments yields attachment_burst", async () => {
    const flags = makeFlags(true);
    const testNow = Date.now();
    // 3 different channels in 60s triggers channel_hop_fast
    const hopMessages = [
      {
        messageId: "a",
        channelId: "ch-1",
        contentHash: "x",
        timestamp: testNow - 10000,
        hasLink: false,
      },
      {
        messageId: "b",
        channelId: "ch-2",
        contentHash: "x",
        timestamp: testNow - 5000,
        hasLink: false,
      },
      {
        messageId: "c",
        channelId: "ch-3",
        contentHash: "x",
        timestamp: testNow - 1000,
        hasLink: false,
      },
    ];
    const result = await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", hopMessages, "new-content", 2, {
        now: () => testNow,
      }),
    );
    expect(result.find((s) => s.name === "channel_hop_fast")).toBeDefined();
    expect(result.find((s) => s.name === "attachment_burst")).toBeDefined();
    expect(result.find((s) => s.name === "attachment_burst")!.score).toBe(2);
  });

  test("gate-disabled returns [] even with attachments and velocity-triggering messages", async () => {
    const flags = makeFlags(false);
    const testNow = Date.now();
    const hopMessages = [
      {
        messageId: "a",
        channelId: "ch-1",
        contentHash: "x",
        timestamp: testNow - 10000,
        hasLink: false,
      },
      {
        messageId: "b",
        channelId: "ch-2",
        contentHash: "x",
        timestamp: testNow - 5000,
        hasLink: false,
      },
      {
        messageId: "c",
        channelId: "ch-3",
        contentHash: "x",
        timestamp: testNow - 1000,
        hasLink: false,
      },
    ];
    const result = await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", hopMessages, "new-content", 3, {
        now: () => testNow,
      }),
    );
    expect(result).toEqual([]);
  });
});
