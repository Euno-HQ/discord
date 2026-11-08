import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Routes } from "discord.js";
import { LRUCache } from "lru-cache";

import { ssrDiscordSdk } from "#~/discord/api.js";

interface DiscordUser {
  username: string;
  global_name: string;
  id: string;
}

const cache = new LRUCache<string, DiscordUser>({
  ttl: 1000 * 60 * 60 * 24 * 14, // 14 days
  ttlAutopurge: true,
  max: 150,
});

// Root filesystem is read-only in k8s; /tmp is a writable emptyDir.
const cachefile = path.join(os.tmpdir(), "userInfoCache.json");
void load();

export async function getOrFetchUser(id: string) {
  if (cache.has(id)) return cache.get(id);

  // @ts-expect-error FIXME: are there types available? schema validation?
  const { username, global_name } = await ssrDiscordSdk.get(Routes.user(id));
  const result = { id, username, global_name } as DiscordUser;
  cache.set(id, result);
  console.log("Fetched user from Discord API:", id);
  void dump();
  return result;
}

export function dump() {
  return fs.writeFile(cachefile, JSON.stringify(cache.dump()), "utf8");
}

export async function load() {
  try {
    const raw = await fs.readFile(cachefile, "utf8");
    cache.load(JSON.parse(raw));
  } catch {
    // ignore errors, file might not exist yet
  }
}
