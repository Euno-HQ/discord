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
    isTierEnabled: () => Effect.succeed(false),
    requireTierFeature: () => Effect.void,
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
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW }),
    );
    expect(result).toEqual(analyzeVelocity(messages, "h"));
  });

  test("returns [] when the flag is disabled", async () => {
    const flags = makeFlags(false);
    const result = await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW }),
    );
    expect(result).toEqual([]);
  });

  test("caches the flag value within the TTL (one lookup)", async () => {
    const calls = { n: 0 };
    const flags = makeFlags(true, calls);
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", {
        now: () => NOW,
        ttlMs: 60_000,
      }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", {
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
      gatedVelocitySignals(flags, "g1", messages, "h", {
        now: () => NOW,
        ttlMs: 60_000,
      }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g1", messages, "h", {
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
      gatedVelocitySignals(flags, "g1", messages, "h", { now: () => NOW }),
    );
    await Effect.runPromise(
      gatedVelocitySignals(flags, "g2", messages, "h", { now: () => NOW }),
    );
    expect(calls.n).toBe(2);
  });
});
