import type { Message, TextChannel } from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database";
import { log } from "#~/helpers/observability";

export const getOrFetchChannel = (msg: Message) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const rows = yield* db
      .selectFrom("channel_info")
      .selectAll()
      .where("id", "=", msg.channelId);
    const channelInfo = rows[0];

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

    const data = yield* Effect.tryPromise({
      try: () => msg.channel.fetch() as Promise<TextChannel>,
      catch: (e) => e,
    });
    const values = {
      id: msg.channelId,
      category: data.parent?.name ?? null,
      category_id: data.parent?.id ?? null,
      name: data.name,
    };

    yield* db.insertInto("channel_info").values(values);

    log("debug", "ActivityTracker", "Channel info added to cache", {
      channelId: msg.channelId,
      channelName: data.name,
      category: data.parent?.name,
      categoryId: data.parent?.id,
    });

    return values;
  });
