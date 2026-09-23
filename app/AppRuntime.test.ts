import { describe, expect, it } from "vitest";

import { getPosthog } from "#~/AppRuntime";

// These run WITHOUT calling warmRuntime() — so they never open the real DB.
// They lock the contract that importing AppRuntime has no side effect and that
// using the handle before warmup fails loudly.
describe("AppRuntime lazy handles (unwarmed)", () => {
  it("getPosthog() throws before warmRuntime()", () => {
    expect(() => getPosthog()).toThrow(/not warmed/);
  });
});
