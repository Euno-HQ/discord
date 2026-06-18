import { PermissionFlagsBits } from "discord-api-types/v10";

import {
  buildHoneypotResult,
  buildLogChannelResult,
  buildOptionalPermissionResults,
} from "./checkRequirements";

describe("buildLogChannelResult", () => {
  it("returns ok:false with unconfigured detail when channelId is undefined", () => {
    const result = buildLogChannelResult(
      "Mod Log Channel",
      undefined,
      null,
      "Not configured",
    );
    expect(result).toEqual({
      name: "Mod Log Channel",
      ok: false,
      detail: "Not configured",
    });
  });

  it("returns null (skip) when channelId is configured but channel is deleted/missing", () => {
    const result = buildLogChannelResult(
      "Mod Log Channel",
      "123456789",
      null,
      "Not configured",
    );
    expect(result).toBeNull();
  });

  it("returns ok:true with channel mention when channel is found", () => {
    const result = buildLogChannelResult(
      "Mod Log Channel",
      "123456789",
      "123456789",
      "Not configured",
    );
    expect(result).toEqual({
      name: "Mod Log Channel",
      ok: true,
      detail: "<#123456789>",
    });
  });

  it("works the same for Deletion Log Channel", () => {
    const missingResult = buildLogChannelResult(
      "Deletion Log Channel",
      "987654321",
      null,
      "Not configured (optional but recommended)",
    );
    expect(missingResult).toBeNull();

    const unconfiguredResult = buildLogChannelResult(
      "Deletion Log Channel",
      undefined,
      null,
      "Not configured (optional but recommended)",
    );
    expect(unconfiguredResult).toEqual({
      name: "Deletion Log Channel",
      ok: false,
      detail: "Not configured (optional but recommended)",
    });
  });
});

describe("buildHoneypotResult", () => {
  it("returns ok:false when no rows are configured", () => {
    const result = buildHoneypotResult(0, []);
    expect(result).toEqual({
      name: "Honeypot",
      ok: false,
      detail: "No honeypot channels configured",
    });
  });

  it("returns ok:true listing valid channels when at least one is found", () => {
    const result = buildHoneypotResult(2, ["111", "222"]);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("<#111>");
    expect(result.detail).toContain("<#222>");
  });

  it("returns ok:false when rows are configured but all channels are deleted/missing", () => {
    // configuredCount > 0 but no valid channels — all were deleted
    const result = buildHoneypotResult(3, []);
    expect(result).toEqual({
      name: "Honeypot",
      ok: false,
      detail: "No honeypot channels found",
    });
  });

  it("does not mention missing channel IDs in the detail when some are deleted", () => {
    // Only one of three configured channels survived; the deleted ones are silently skipped.
    const result = buildHoneypotResult(3, ["555"]);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("<#555>");
    expect(result.detail).not.toContain("missing");
  });
});

describe("buildOptionalPermissionResults", () => {
  it("reports the enabled feature when the permission is granted", () => {
    const results = buildOptionalPermissionResults(() => true);
    const manageServer = results.find((r) => r.name === "Manage Server");
    expect(manageServer).toEqual({
      name: "Manage Server",
      ok: true,
      optional: true,
      detail: "Granted — automod rule change logging enabled",
    });
  });

  it("reports the disabled feature as optional when the permission is missing", () => {
    const results = buildOptionalPermissionResults(() => false);
    const manageServer = results.find((r) => r.name === "Manage Server");
    expect(manageServer).toEqual({
      name: "Manage Server",
      ok: false,
      optional: true,
      detail: "Not granted (optional) — automod rule change logging disabled",
    });
  });

  it("checks the ManageGuild flag specifically", () => {
    const checked: bigint[] = [];
    buildOptionalPermissionResults((flag) => {
      checked.push(flag);
      return true;
    });
    expect(checked).toContain(PermissionFlagsBits.ManageGuild);
  });
});
