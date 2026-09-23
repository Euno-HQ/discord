import type { Message, TextChannel } from "discord.js";
import { Effect } from "effect";

import { DatabaseService, type SqlError } from "#~/Database";
import type { DB } from "#~/db";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import type { DiscordError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";

type ChannelInfo = DB["channel_info"];

export const getOrFetchChannel = (
  msg: Message,
): Effect.Effect<ChannelInfo, SqlError | DiscordError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    // TODO: cache eviction?
    const [channelInfo] = yield* db
      .selectFrom("channel_info")
      .selectAll()
      .where("id", "=", msg.channelId);

    if (channelInfo) {
      yield* logEffect(
        "debug",
        "ActivityTracker",
        "Channel info found in cache",
        {
          channelId: msg.channelId,
          channelName: channelInfo.name,
          category: channelInfo.category,
        },
      );
      return channelInfo;
    }

    yield* logEffect(
      "debug",
      "ActivityTracker",
      "Fetching channel info from Discord",
      {
        channelId: msg.channelId,
      },
    );

    const data = yield* tryDiscord(
      "fetchChannel",
      () => msg.channel.fetch() as Promise<TextChannel>,
    );
    const values: ChannelInfo = {
      id: msg.channelId,
      category: data.parent?.name ?? null,
      category_id: data.parent?.id ?? null,
      name: data.name,
    };

    yield* db.insertInto("channel_info").values(values);

    yield* logEffect(
      "debug",
      "ActivityTracker",
      "Channel info added to cache",
      {
        channelId: msg.channelId,
        channelName: data.name,
        category: data.parent?.name,
        categoryId: data.parent?.id,
      },
    );

    return values;
  });
