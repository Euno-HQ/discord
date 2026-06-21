import type { REST } from "@discordjs/rest";
import TTLCache from "@isaacs/ttlcache";

import { runEffect } from "#~/AppRuntime";
import { log } from "#~/helpers/observability";
import { fetchGuilds, type Guild } from "#~/models/discord.server";

export interface CachedGuild {
  id: string;
  name: string;
  icon?: string;
  hasBot: boolean;
  authz: string[];
}

// TTL cache for guild data - 5 minute TTL, max 100 users
const guildCache = new TTLCache<string, CachedGuild[]>({
  ttl: 5 * 60 * 1000,
  max: 100,
});

function toCachedGuild(g: Guild): CachedGuild {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    hasBot: g.hasBot,
    authz: g.authz,
  };
}

export async function getCachedGuilds(
  userId: string,
  userRest: REST,
  botRest: REST,
): Promise<CachedGuild[]> {
  const cached = guildCache.get(userId);
  if (cached) return cached;

  const guilds = await runEffect(fetchGuilds(userRest, botRest));
  const result = guilds.map(toCachedGuild);
  guildCache.set(userId, result);

  log("info", "guildCache", "Guilds fetched and cached", {
    userId,
    totalGuilds: result.length,
    manageableGuilds: result.filter((g) => g.hasBot).length,
  });

  return result;
}
