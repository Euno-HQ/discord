import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { PostHog } from "posthog-node";
import { vi } from "vitest";

import { FeatureFlagService, FeatureFlagServiceLive } from "./featureFlags";
import { PostHogService } from "./posthog";

// Real tag, no env/DB: posthog.ts pulls in env.server + the subscriptions model.
vi.mock("#~/effects/posthog", async () => {
  const { Context, Layer } = await import("effect");
  class PostHogService extends Context.Service<PostHogService, unknown>()(
    "PostHogService",
  ) {}
  return { PostHogService, PostHogServiceLive: Layer.empty };
});

const setup = (impl: (flag: string, guildId: string) => Promise<boolean>) => {
  const client = new PostHog("phc_test", { disabled: true });
  const isFeatureEnabled = vi
    .spyOn(client, "isFeatureEnabled")
    .mockImplementation(impl);
  const layer = FeatureFlagServiceLive.pipe(
    Layer.provide(Layer.succeed(PostHogService, client)),
  );
  return { isFeatureEnabled, layer };
};

const check = (flag: "analytics" | "escalate", guildId: string) =>
  Effect.flatMap(FeatureFlagService, (f) => f.isPostHogEnabled(flag, guildId));

test("caches per (flag, guild) and re-evaluates after the 60s TTL", async () => {
  const { isFeatureEnabled, layer } = setup(async () => true);
  await Effect.gen(function* () {
    expect(yield* check("analytics", "g1")).toBe(true);
    expect(yield* check("analytics", "g1")).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(1);

    // Different flag or guild is a different key.
    yield* check("escalate", "g1");
    yield* check("analytics", "g2");
    expect(isFeatureEnabled).toHaveBeenCalledTimes(3);

    yield* TestClock.adjust("61 seconds");
    yield* check("analytics", "g1");
    expect(isFeatureEnabled).toHaveBeenCalledTimes(4);
  }).pipe(
    Effect.provide(Layer.merge(layer, TestClock.layer())),
    Effect.runPromise,
  );
});

test("a failed evaluation fails closed but is not cached", async () => {
  let fail = true;
  const { isFeatureEnabled, layer } = setup(async () => {
    if (fail) throw new Error("posthog down");
    return true;
  });
  await Effect.gen(function* () {
    expect(yield* check("analytics", "g1")).toBe(false);
    fail = false;
    // Next call retries immediately rather than serving a pinned `false`.
    expect(yield* check("analytics", "g1")).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(2);
  }).pipe(
    Effect.provide(Layer.merge(layer, TestClock.layer())),
    Effect.runPromise,
  );
});
