import { describe, expect, it } from "vitest";

import { db, getPosthog } from "#~/AppRuntime";

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
