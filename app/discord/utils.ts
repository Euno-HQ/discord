import type { Message, TextChannel } from "discord.js";

import { db, run, runTakeFirst } from "#~/AppRuntime";
import { log } from "#~/helpers/observability";

export async function getOrFetchChannel(msg: Message) {
  // TODO: cache eviction?
  const channelInfo = await runTakeFirst(
    db.selectFrom("channel_info").selectAll().where("id", "=", msg.channelId),
  );

  if (channelInfo) {
    log("debug", "ActivityTracker", "Channel info found in cache", {
      channelId: msg.channelId,
      channelName: channelInfo.name,
      category: channelInfo.category,
    });
    return channelInfo;
  }

  log("debug", "ActivityTracker", "Fetching channel info from Discord", {
    channelId: msg.channelId,
  });

  const data = (await msg.channel.fetch()) as TextChannel;
  const values = {
    id: msg.channelId,
    category: data.parent?.name ?? null,
    category_id: data.parent?.id ?? null,
    name: data.name,
  };

  await run(db.insertInto("channel_info").values(values));

  log("debug", "ActivityTracker", "Channel info added to cache", {
    channelId: msg.channelId,
    channelName: data.name,
    category: data.parent?.name,
    categoryId: data.parent?.id,
  });

  return values;
}
