import {
  ChannelType,
  Routes,
  type APIChannel,
  type APIRole,
} from "discord-api-types/v10";
import { Effect } from "effect";

import { ssrDiscordSdk } from "#~/discord/api";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import { logEffect } from "#~/effects/observability";

export interface GuildRole {
  id: string;
  name: string;
  position: number;
  color: number;
}

export interface GuildChannel {
  id: string;
  name: string;
  position: number;
  type: number;
  parentId?: string | null;
}

export interface ProcessedChannel {
  type: "channel" | "category";
  data: GuildChannel;
  children?: GuildChannel[];
}

export interface GuildData {
  roles: GuildRole[];
  channels: ProcessedChannel[];
}

function toGuildChannel(ch: APIChannel): GuildChannel {
  return {
    id: ch.id,
    name: ch.name ?? "",
    position: "position" in ch ? (ch.position ?? 0) : 0,
    type: ch.type,
    parentId: "parent_id" in ch ? (ch.parent_id ?? null) : null,
  };
}

const EMPTY_RESULT: GuildData = { roles: [], channels: [] };

export function fetchGuildData(
  guildId: string,
): Effect.Effect<GuildData, never, never> {
  return Effect.gen(function* () {
    const [apiRoles, apiChannels] = yield* Effect.all([
      tryDiscord(
        "fetchGuildRoles",
        () =>
          ssrDiscordSdk.get(Routes.guildRoles(guildId)) as Promise<APIRole[]>,
      ),
      tryDiscord(
        "fetchGuildChannels",
        () =>
          ssrDiscordSdk.get(Routes.guildChannels(guildId)) as Promise<
            APIChannel[]
          >,
      ),
    ]);

    const roles = apiRoles
      .filter((role) => role.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        position: r.position,
        color: r.color,
      }));

    const categories = apiChannels
      .filter((ch) => ch.type === ChannelType.GuildCategory)
      .sort(
        (a, b) =>
          ("position" in a ? (a.position ?? 0) : 0) -
          ("position" in b ? (b.position ?? 0) : 0),
      );

    const textChannels = apiChannels
      .filter((ch) => ch.type === ChannelType.GuildText)
      .sort(
        (a, b) =>
          ("position" in a ? (a.position ?? 0) : 0) -
          ("position" in b ? (b.position ?? 0) : 0),
      );

    yield* logEffect("info", "guildData", "Guild data fetched successfully", {
      guildId,
      rolesCount: roles.length,
      channelsCount: textChannels.length,
      categoriesCount: categories.length,
    });

    const channelsByCategory = new Map<string, GuildChannel[]>();
    for (const ch of textChannels) {
      const parentId = "parent_id" in ch ? ch.parent_id : null;
      if (parentId) {
        if (!channelsByCategory.has(parentId)) {
          channelsByCategory.set(parentId, []);
        }
        channelsByCategory.get(parentId)!.push(toGuildChannel(ch));
      }
    }

    const channels: ProcessedChannel[] = [
      ...textChannels
        .filter((ch) => !("parent_id" in ch) || !ch.parent_id)
        .map((ch) => ({ type: "channel" as const, data: toGuildChannel(ch) })),
      ...categories.map((cat) => ({
        type: "category" as const,
        data: toGuildChannel(cat),
        children: (channelsByCategory.get(cat.id) ?? []).sort(
          (a, b) => a.position - b.position,
        ),
      })),
    ];

    return { roles, channels };
  }).pipe(
    Effect.withSpan("guildData.fetch", { attributes: { guildId } }),
    Effect.catchAll((e) =>
      logEffect("error", "guildData", "Failed to fetch guild data", {
        guildId,
        error: e,
      }).pipe(Effect.as(EMPTY_RESULT)),
    ),
  );
}
