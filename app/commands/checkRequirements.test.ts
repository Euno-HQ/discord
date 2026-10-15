import { PermissionFlagsBits } from "discord-api-types/v10";
import { PermissionsBitField } from "discord.js";

import {
  alertableFailures,
  applyLogChannelPerms,
  buildHoneypotResult,
  buildLogChannelResult,
  buildOptionalPermissionResults,
  buildTicketResult,
} from "./checkRequirements";

describe("buildLogChannelResult", () => {
  it("returns optional (🔵) with unconfigured detail when channelId is undefined", () => {
    const result = buildLogChannelResult(
      "Mod Log Channel",
      undefined,
      null,
      "Not configured",
    );
    expect(result).toEqual({
      name: "Mod Log Channel",
      ok: false,
      optional: true,
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
      optional: true,
      detail: "Not configured (optional but recommended)",
    });
  });
});

describe("buildHoneypotResult", () => {
  it("returns optional (🔵) when no rows are configured", () => {
    const result = buildHoneypotResult(0, []);
    expect(result).toEqual({
      name: "Honeypot",
      ok: false,
      optional: true,
      detail: "Not configured",
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

describe("applyLogChannelPerms", () => {
  // Built from real discord.js primitives, not a hand-shaped mock. The bug this
  // guards against was invisible to mocks precisely because the mocks never
  // modelled the difference between "channel resolved" and "bot can use it":
  // guild.channels.fetch() is served from cache, so a revoked ViewChannel
  // produces no API error at all and the check went green while every write to
  // the channel failed with Missing Access.
  const channelWith = (perms: bigint) => ({
    id: "chan-1",
    permissionsFor: () => new PermissionsBitField(perms),
  });
  const guildWith = (channel: unknown) =>
    ({
      members: { me: { id: "bot-1" } },
      channels: { fetch: () => Promise.resolve(channel) },
    }) as never;

  const ALL =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.CreatePrivateThreads |
    PermissionFlagsBits.ManageThreads;

  const okResult = () => ({
    name: "Mod Log Channel",
    ok: true,
    detail: "<#chan-1>",
  });

  it("leaves an ok result alone when the bot has every needed permission", () => {
    const channel = channelWith(ALL);
    expect(
      applyLogChannelPerms(okResult(), guildWith(channel), {
        kind: "ok",
        value: channel,
      }),
    ).toEqual(okResult());
  });

  it("fails the check and names the permission when ViewChannel is revoked", () => {
    const channel = channelWith(ALL & ~PermissionFlagsBits.ViewChannel);
    const result = applyLogChannelPerms(okResult(), guildWith(channel), {
      kind: "ok",
      value: channel,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ViewChannel");
  });

  it("names every missing permission, not just the first", () => {
    const channel = channelWith(PermissionFlagsBits.ViewChannel);
    const result = applyLogChannelPerms(okResult(), guildWith(channel), {
      kind: "ok",
      value: channel,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("SendMessages");
    expect(result.detail).toContain("ManageThreads");
  });

  it("does not second-guess a result that already failed", () => {
    const failed = {
      name: "Mod Log Channel",
      ok: false,
      detail: "Not configured",
    };
    expect(
      applyLogChannelPerms(failed, guildWith(null), { kind: "missing" }),
    ).toEqual(failed);
  });
});

describe("buildTicketResult", () => {
  const TICKET_PERMS =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.CreatePrivateThreads |
    PermissionFlagsBits.SendMessagesInThreads;
  const channelWith = (id: string, perms: bigint) => ({
    id,
    permissionsFor: () => new PermissionsBitField(perms),
  });
  // A fetch that fails the test if called: scoping must be cache-only.
  const guildWith = (...channels: { id: string }[]) =>
    ({
      members: { me: { id: "bot-1" } },
      channels: {
        cache: new Map(channels.map((c) => [c.id, c])),
        fetch: () => {
          throw new Error("ticket check must not hit the API");
        },
      },
    }) as never;

  it("ignores rows for channels outside this guild without fetching", () => {
    const result = buildTicketResult(guildWith(), ["other-guild-chan", null]);
    expect(result).toEqual({
      name: "Tickets",
      ok: false,
      optional: true,
      detail: "Not configured",
    });
  });

  it("passes when the bot can open tickets in the channel", () => {
    const guild = guildWith(channelWith("t1", TICKET_PERMS));
    const result = buildTicketResult(guild, ["t1", "elsewhere", "t1"]);
    expect(result).toEqual({ name: "Tickets", ok: true, detail: "<#t1>" });
  });

  it("is a required failure naming the channel and missing perms", () => {
    const guild = guildWith(
      channelWith("t1", TICKET_PERMS),
      channelWith("t2", PermissionFlagsBits.SendMessagesInThreads),
    );
    const result = buildTicketResult(guild, ["t1", "t2"]);
    expect(result.ok).toBe(false);
    expect(result.optional).toBeUndefined();
    expect(result.detail).toBe(
      "<#t1>, <#t2> — bot missing: ViewChannel, CreatePrivateThreads",
    );
  });
});

describe("alertableFailures", () => {
  it("keeps only required, conclusive failures", () => {
    const results = [
      { name: "ok", ok: true, detail: "" },
      { name: "blue", ok: false, optional: true, detail: "Not configured" },
      { name: "flaky", ok: false, inconclusive: true, detail: "⚠️" },
      { name: "red", ok: false, detail: "broken" },
    ];
    expect(alertableFailures(results).map((r) => r.name)).toEqual(["red"]);
  });
});
