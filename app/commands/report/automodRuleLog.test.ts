import type { AutoModerationRule } from "discord.js";

import { buildUpdateDiff } from "./automodRuleLog";

// Minimal stub builder — buildUpdateDiff only reads name, enabled,
// triggerMetadata, actions, exemptRoles.size, exemptChannels.size.
const makeRule = (overrides: {
  name?: string;
  enabled?: boolean;
  keywordFilter?: string[];
  regexPatterns?: string[];
  allowList?: string[];
  actionTypes?: number[];
  exemptRoles?: number;
  exemptChannels?: number;
}): AutoModerationRule =>
  ({
    name: overrides.name ?? "rule",
    enabled: overrides.enabled ?? true,
    triggerMetadata: {
      keywordFilter: overrides.keywordFilter ?? [],
      regexPatterns: overrides.regexPatterns ?? [],
      allowList: overrides.allowList ?? [],
    },
    actions: (overrides.actionTypes ?? []).map((type) => ({ type })),
    exemptRoles: { size: overrides.exemptRoles ?? 0 },
    exemptChannels: { size: overrides.exemptChannels ?? 0 },
  }) as unknown as AutoModerationRule;

test("returns generic message when old rule is unavailable", () => {
  expect(buildUpdateDiff(null, makeRule({}))).toBe("configuration changed");
});

test("same-count keyword swap surfaces the actual changed keywords", () => {
  const oldRule = makeRule({ keywordFilter: ["spam", "scam"] });
  const newRule = makeRule({ keywordFilter: ["spam", "phish"] });

  const result = buildUpdateDiff(oldRule, newRule);

  // Regression for #398: a same-count swap must NOT fall through to the
  // "minor configuration change" fallback.
  expect(result).not.toContain("minor configuration change");
  expect(result).toContain("keywords:");
  expect(result).toContain("`phish`"); // added
  expect(result).toContain("`scam`"); // removed
  expect(result).not.toContain("`spam`"); // unchanged, not listed
});

test("added-only keywords show a + segment", () => {
  const result = buildUpdateDiff(
    makeRule({ keywordFilter: ["a"] }),
    makeRule({ keywordFilter: ["a", "b", "c"] }),
  );
  expect(result).toContain("keywords:");
  expect(result).toContain("+");
  expect(result).toContain("`b`");
  expect(result).toContain("`c`");
});

test("removed-only keywords show a − segment", () => {
  const result = buildUpdateDiff(
    makeRule({ keywordFilter: ["a", "b"] }),
    makeRule({ keywordFilter: ["a"] }),
  );
  expect(result).toContain("keywords:");
  expect(result).toContain("−");
  expect(result).toContain("`b`");
});

test("regex pattern swap is surfaced element-by-element", () => {
  const result = buildUpdateDiff(
    makeRule({ regexPatterns: ["foo.*"] }),
    makeRule({ regexPatterns: ["bar.*"] }),
  );
  expect(result).not.toContain("minor configuration change");
  expect(result).toContain("regex:");
  expect(result).toContain("`bar.*`");
  expect(result).toContain("`foo.*`");
});

test("action/response type changes are surfaced", () => {
  // 1 = BlockMessage, 3 = Timeout (AutoModerationActionType values)
  const result = buildUpdateDiff(
    makeRule({ actionTypes: [1] }),
    makeRule({ actionTypes: [1, 3] }),
  );
  expect(result).toContain("actions:");
  expect(result).toContain("`3`");
});

test("long keyword lists are truncated with an overflow count", () => {
  const result = buildUpdateDiff(
    makeRule({ keywordFilter: [] }),
    makeRule({ keywordFilter: ["1", "2", "3", "4", "5", "6", "7"] }),
  );
  expect(result).toContain("more");
});

test("name and enabled changes still render", () => {
  const result = buildUpdateDiff(
    makeRule({ name: "old", enabled: true }),
    makeRule({ name: "new", enabled: false }),
  );
  expect(result).toContain("**old** → **new**");
  expect(result).toContain("enabled: true → false");
});

test("falls back to minor configuration change when nothing comparable changed", () => {
  // Exempt-role count changes can't be expressed element-wise here, but an
  // identical rule must still produce the fallback.
  const rule = makeRule({ keywordFilter: ["x"] });
  expect(buildUpdateDiff(rule, makeRule({ keywordFilter: ["x"] }))).toBe(
    "minor configuration change",
  );
});

test("exempt role/channel count deltas still render", () => {
  const result = buildUpdateDiff(
    makeRule({ exemptRoles: 1, exemptChannels: 0 }),
    makeRule({ exemptRoles: 2, exemptChannels: 1 }),
  );
  expect(result).toContain("+1 exempt role");
  expect(result).toContain("+1 exempt channel");
});
