import { vi } from "vitest";

import { runEffect } from "#~/AppRuntime";
import { ssrDiscordSdk, userDiscordSdkFromRequest } from "#~/discord/api";
import {
  getCachedGuilds,
  type CachedGuild,
} from "#~/helpers/guildCache.server";

import { userManagesGuild } from "./guildAuth.server";

// The helper crosses the Effect boundary via runEffect(getCachedGuilds(...)).
// Stub runEffect to return controlled CachedGuild fixtures so we can assert the
// pure membership decision without a live Discord API / runtime.
vi.mock("#~/AppRuntime", () => ({ runEffect: vi.fn() }));
vi.mock("#~/discord/api", () => ({
  userDiscordSdkFromRequest: vi.fn(),
  ssrDiscordSdk: { __brand: "ssrDiscordSdk" },
}));
vi.mock("#~/helpers/guildCache.server", () => ({ getCachedGuilds: vi.fn() }));

// Real CachedGuild shape (see app/helpers/guildCache.server.ts): every entry is
// a guild the user manages (MANAGER authz); hasBot only records bot presence.
const managedWithBot: CachedGuild = {
  id: "614601782152265748",
  name: "Reactiflux test server",
  hasBot: true,
  authz: ["MANAGER", "MANAGE_GUILD"],
};
const managedWithoutBot: CachedGuild = {
  id: "1442358269497577665",
  name: "Euno",
  hasBot: false, // bot kicked, but the user still manages the guild
  authz: ["MANAGER", "ADMIN"],
};

const request = new Request("http://localhost/export-data");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(userDiscordSdkFromRequest).mockResolvedValue({} as never);
});

describe("userManagesGuild", () => {
  test("true when the guild is in the user's managed list (bot present)", async () => {
    vi.mocked(runEffect).mockResolvedValue([managedWithBot, managedWithoutBot]);

    await expect(
      userManagesGuild(request, "user-1", "614601782152265748"),
    ).resolves.toBe(true);
  });

  test("true for a managed guild even when the bot was kicked (hasBot=false)", async () => {
    // Key nuance: a GDPR export/delete must remain possible after the owner
    // kicks the bot. Managing the guild is the authorization, not bot presence.
    vi.mocked(runEffect).mockResolvedValue([managedWithBot, managedWithoutBot]);

    await expect(
      userManagesGuild(request, "user-1", "1442358269497577665"),
    ).resolves.toBe(true);
  });

  test("false when the guild is not in the user's managed list", async () => {
    vi.mocked(runEffect).mockResolvedValue([managedWithBot, managedWithoutBot]);

    await expect(
      userManagesGuild(request, "user-1", "1234567890123456789"),
    ).resolves.toBe(false);
  });

  test("false when the user manages no guilds at all", async () => {
    vi.mocked(runEffect).mockResolvedValue([]);

    await expect(
      userManagesGuild(request, "user-1", "614601782152265748"),
    ).resolves.toBe(false);
  });

  test("resolves the user's guild list via getCachedGuilds with the user's REST client", async () => {
    vi.mocked(runEffect).mockResolvedValue([managedWithBot]);
    const userRest = { __brand: "userRest" };
    vi.mocked(userDiscordSdkFromRequest).mockResolvedValue(userRest as never);

    await userManagesGuild(request, "user-42", "614601782152265748");

    expect(userDiscordSdkFromRequest).toHaveBeenCalledWith(request);
    expect(getCachedGuilds).toHaveBeenCalledWith(
      "user-42",
      userRest,
      ssrDiscordSdk,
    );
  });
});
