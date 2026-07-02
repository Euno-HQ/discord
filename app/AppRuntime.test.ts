import { afterAll, describe, expect, it } from "vitest";

import { db, getPosthog, runtime } from "#~/AppRuntime";
import { EscalationService } from "#~/commands/escalate/service.ts";

// These run WITHOUT calling warmRuntime() — so they never open the real DB.
// They lock the contract that importing AppRuntime has no side effect and that
// using the handles before warmup fails loudly.
describe("AppRuntime lazy handles (unwarmed)", () => {
  it("getPosthog() throws before warmRuntime()", () => {
    expect(() => getPosthog()).toThrow(/not warmed/);
  });

  it("accessing a db property throws before warmRuntime()", () => {
    expect(() => db.selectFrom("users")).toThrow(/not warmed/);
  });
});

// Layer-composition proof: EscalationServiceLive moved from per-call
// Effect.provide sites into AppLayer, and that wiring is only exercised at
// runtime. ManagedRuntime builds the ENTIRE memoized AppLayer on first use,
// so resolving one service here proves the whole composition constructs —
// every Layer.provide has its inputs satisfied and no service is missing.
//
// Safe without credentials because NODE_ENV=test blanks all env values:
// DATABASE_URL="" gives SQLite an anonymous temp DB (not ./mod-bot.sqlite3),
// PostHog has no key (null client, no network), and the discord.js Client is
// constructed but never logs in. This does NOT set the warmRuntime() flag,
// so the unwarmed-handle tests above are unaffected.
describe("AppLayer composition", () => {
  afterAll(async () => {
    // Close the AppLayer scope (SQLite connection, event-bus queue, tracing).
    await runtime.dispose();
  });

  it("resolves EscalationService from the real AppLayer", async () => {
    const service = await runtime.runPromise(EscalationService);

    // Spot-check the interface actually materialized.
    expect(typeof service.createEscalation).toBe("function");
    expect(typeof service.getEscalation).toBe("function");
    expect(typeof service.executeResolution).toBe("function");
  });
});
