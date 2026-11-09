import { afterEach, describe, expect, it, vi } from "vitest";

import { buildVersionPayload } from "./version.server";

describe("buildVersionPayload", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("falls back to unknown, has the expected fields, leaks nothing identifying", () => {
    vi.stubEnv("GIT_SHA", "");
    vi.stubEnv("RELEASE_TAG", "");
    vi.stubEnv("DISCORD_HASH", "super-secret");
    const p = buildVersionPayload({
      isReady: () => true,
      ws: { ping: 42 },
      guilds: { cache: { size: 3 } },
    });
    expect(p.commit).toBe("unknown");
    expect(p.releaseTag).toBeNull();
    expect(Object.keys(p).sort()).toEqual(
      [
        "commit",
        "discord",
        "environment",
        "memory",
        "node",
        "releaseTag",
        "startedAt",
        "uptimeSeconds",
      ].sort(),
    );
    expect(p.discord).toEqual({ ready: true, pingMs: 42, guildCount: 3 });
    expect(JSON.stringify(p)).not.toContain("super-secret");
    expect(buildVersionPayload(null).discord).toEqual({
      ready: false,
      pingMs: null,
      guildCount: null,
    });
  });
});
