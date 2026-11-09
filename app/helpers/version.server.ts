import { isProd } from "#~/helpers/env.server";

const startedAt = new Date();

/** The slice of discord.js's Client this payload reads. */
export interface DiscordStatus {
  isReady(): boolean;
  ws: { ping: number };
  guilds: { cache: { size: number } };
}

// Unset and empty (Docker ARG default) both mean "not provided".
const nonEmpty = (v: string | undefined) => (v === "" ? undefined : v);

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * Public diagnostics payload. Counts and versions only: no guild, user, env,
 * or host identifiers. Pass `null` when the Discord client isn't available.
 */
export const buildVersionPayload = (client: DiscordStatus | null) => {
  const ready = client?.isReady() ?? false;
  const mem = process.memoryUsage();
  return {
    commit: nonEmpty(process.env.GIT_SHA) ?? "unknown",
    releaseTag: nonEmpty(process.env.RELEASE_TAG) ?? null,
    environment: isProd() ? "production" : "development",
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    node: process.version,
    memory: { rssMB: mb(mem.rss), heapUsedMB: mb(mem.heapUsed) },
    discord: {
      ready,
      pingMs: ready && client!.ws.ping >= 0 ? client!.ws.ping : null,
      guildCount: ready ? client!.guilds.cache.size : null,
    },
  };
};
