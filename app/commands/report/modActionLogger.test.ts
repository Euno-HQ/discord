import type { AutoModerationRule } from "discord.js";

import { resolveRuleName } from "./modActionLogger";

const rule = (name: string) => ({ name }) as unknown as AutoModerationRule;

test("prefers the freshly fetched rule name", () => {
  expect(resolveRuleName(rule("Keyword filter"), rule("stale cache"))).toBe(
    "Keyword filter",
  );
});

test("falls back to the cached rule name when fetch returned null", () => {
  // Regression for #399: the action-execution payload's cached rule is usually
  // empty, but if a fetch fails we still prefer any name we have over the
  // "Unknown rule" placeholder.
  expect(resolveRuleName(null, rule("Cached name"))).toBe("Cached name");
});

test("falls back to a stable placeholder when no rule is resolvable", () => {
  expect(resolveRuleName(null, null)).toBe("Unknown rule");
});
