import { Effect, Exit, Schema } from "effect";
import { vi } from "vitest";

import { FeatureDisabledError } from "./errors";
import {
  BooleanFlag,
  guardFeature,
  withFeatureFlag,
  type IFeatureFlagService,
} from "./featureFlags";

// Mock heavy transitive deps that featureFlags.ts imports but we don't use
vi.mock("#~/Database", () => ({
  DatabaseService: { key: "DatabaseService" },
  DatabaseLayer: {},
}));
vi.mock("#~/effects/posthog", () => ({
  PostHogService: { key: "PostHogService" },
  PostHogServiceLive: {},
}));

describe("withFeatureFlag", () => {
  test("runs onEnabled when check returns true", async () => {
    const result = await Effect.runPromise(
      withFeatureFlag(
        Effect.succeed(true),
        Effect.succeed("enabled-path"),
        Effect.succeed("disabled-path"),
      ),
    );
    expect(result).toBe("enabled-path");
  });

  test("runs onDisabled when check returns false", async () => {
    const result = await Effect.runPromise(
      withFeatureFlag(
        Effect.succeed(false),
        Effect.succeed("enabled-path"),
        Effect.succeed("disabled-path"),
      ),
    );
    expect(result).toBe("disabled-path");
  });

  test("propagates defects from the check effect", async () => {
    const exit = await Effect.runPromiseExit(
      withFeatureFlag(
        Effect.die("check failed"),
        Effect.succeed("enabled-path"),
        Effect.succeed("disabled-path"),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("guardFeature", () => {
  const makeMockFlags = (enabled: boolean): IFeatureFlagService => ({
    isPostHogEnabled: (_flag, _guildId) => Effect.succeed(enabled),
    getPostHogValue: () => Effect.die("not implemented"),
    isTierEnabled: () => Effect.succeed(false),
    requireTierFeature: () => Effect.void,
  });

  test("succeeds when isPostHogEnabled returns true", async () => {
    const flags = makeMockFlags(true);
    const exit = await Effect.runPromiseExit(
      guardFeature(flags, "analytics", "guild-1"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test('fails with FeatureDisabledError (reason "not_in_rollout") when returns false', async () => {
    const flags = makeMockFlags(false);
    const exit = await Effect.runPromiseExit(
      guardFeature(flags, "analytics", "guild-1"),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.toString();
      expect(error).toContain("FeatureDisabledError");
    }
  });

  test("error carries correct feature and guildId", async () => {
    const flags = makeMockFlags(false);
    const result = await Effect.runPromise(
      guardFeature(flags, "escalate", "guild-42").pipe(
        Effect.catchTag("FeatureDisabledError", (e) => Effect.succeed(e)),
      ),
    );

    expect(result).toBeInstanceOf(FeatureDisabledError);
    if (result instanceof FeatureDisabledError) {
      expect(result.feature).toBe("escalate");
      expect(result.guildId).toBe("guild-42");
      expect(result.reason).toBe("not_in_rollout");
    }
  });
});

describe("BooleanFlag", () => {
  test.each(["velocity-spam", "member-applications", "data-export"])(
    "accepts %s",
    (key) => {
      expect(Schema.decodeUnknownSync(BooleanFlag)(key)).toBe(key);
    },
  );
});
