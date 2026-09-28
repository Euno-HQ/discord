import { ChannelType, type Guild, type TextChannel } from "discord.js";
import { Effect } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { deployToGuild } from "#~/discord/deployCommands.server";
import type { GuildCreateEvent, GuildDeleteEvent } from "#~/discord/events";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import {
  ResourceMissingError,
  type DiscordError,
  type SqlError,
} from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { botStats } from "#~/helpers/metrics";
import { fetchGuild } from "#~/models/guilds.server";

const WELCOME_MESSAGE = `Euno is here! Run \`/setup\` to get started.`;

/**
 * Try to send a welcome message to the most appropriate channel in the guild.
 * Tries in order: system channel, public updates channel, then any channel
 * with "mod" or "intro" in the name. Gives up silently if all fail.
 */
const sendWelcome = (guild: Guild) =>
  tryDiscord("sendWelcomeSystemChannel", () =>
    guild.systemChannel!.send(WELCOME_MESSAGE),
  ).pipe(
    Effect.catchAll(() =>
      tryDiscord("sendWelcomePublicUpdatesChannel", () =>
        guild.publicUpdatesChannel!.send(WELCOME_MESSAGE),
      ),
    ),
    Effect.catchAll(() =>
      Effect.gen(function* () {
        const channels = yield* tryDiscord("fetchGuildChannelsForWelcome", () =>
          guild.channels.fetch(),
        );
        const likelyChannels = channels.filter((c): c is TextChannel =>
          Boolean(
            c &&
              c.type === ChannelType.GuildText &&
              (c.name.includes("mod") || c.name.includes("intro")),
          ),
        );
        const channelArray = [...likelyChannels.values()];
        // Build a chain of fallbacks: try first channel, then second, etc.
        const attempts = channelArray.reduce<
          Effect.Effect<unknown, DiscordError>
        >(
          (acc, ch) =>
            acc.pipe(
              Effect.catchAll(() =>
                tryDiscord("sendWelcomeFallbackChannel", () =>
                  ch.send(WELCOME_MESSAGE),
                ),
              ),
            ),
          Effect.fail(
            new ResourceMissingError({
              source: "discord",
              operation: "sendWelcomeFallbackChannel",
              cause: new Error("no likely channels found"),
            }),
          ),
        );
        yield* attempts;
      }),
    ),
    Effect.catchAll(() => Effect.void), // give up silently
  );

export const handleGuildCreate = (
  e: GuildCreateEvent,
): Effect.Effect<void, DiscordError | SqlError, RuntimeContext> =>
  Effect.gen(function* () {
    const appGuild = yield* fetchGuild(e.guild.id);

    botStats.guildJoined(e.guild);

    // Guild already exists in DB — this is a reconnect, not a new install
    if (appGuild) return;

    yield* logEffect("info", "OnboardGuild", "New guild installed", {
      guildId: e.guild.id,
      guildName: e.guild.name,
    });

    yield* tryDiscord("deployToGuild", () =>
      deployToGuild(e.guild.id, e.guild.name),
    );

    yield* sendWelcome(e.guild);
  });

export const handleGuildDelete = (
  e: GuildDeleteEvent,
): Effect.Effect<void, SqlError, RuntimeContext> =>
  Effect.gen(function* () {
    // GuildDelete also fires when a guild becomes temporarily unavailable
    if (e.guild.available === false) return;

    const appGuild = yield* fetchGuild(e.guild.id);

    if (!appGuild) return;

    botStats.guildRemoved(e.guild);

    yield* logEffect("info", "OnboardGuild", "Guild removed bot", {
      guildId: e.guild.id,
      guildName: e.guild.name,
    });
  });
