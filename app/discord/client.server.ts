import { ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";
import { Context, Layer } from "effect";

import { botInviteUrl } from "#~/helpers/botPermissions";
import { discordToken } from "#~/helpers/env.server";
import { log, trackPerformance } from "#~/helpers/observability";

// Construct the discord.js Client. Factored out so the Layer owns construction
// rather than a bare module-level singleton.
const makeClient = (): Client =>
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildEmojisAndStickers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.AutoModerationExecution,
      GatewayIntentBits.AutoModerationConfiguration,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

/**
 * The bot's discord.js Client, exposed as an Effect service.
 *
 * Bot-only: the client lives in `AppLayer` (part of `RuntimeContext`), so any
 * bot-side effect can `yield* DiscordClient` to reach it. The single instance
 * is created once when the Layer is built and held for the process lifetime.
 *
 * NOTE: this is deliberately NOT the path web/shared code uses to talk to
 * Discord — that's the REST-based `ssrDiscordSdk` in `app/discord/api.ts`,
 * which stays separate pending the #317 boundary decision.
 */
export class DiscordClient extends Context.Tag("DiscordClient")<
  DiscordClient,
  Client
>() {}

export const DiscordClientLayer = Layer.sync(DiscordClient, makeClient);

export const login = (client: Client) => {
  return trackPerformance(
    "discord_login",
    async () => {
      log("info", "Client", "Starting Discord client login", {});

      await client.login(discordToken);

      log("info", "Client", "Discord client login successful", {});

      client.user?.setActivity("server activity…", {
        type: ActivityType.Watching,
      });

      try {
        const guilds = await client.guilds.fetch();
        const guildNames = guilds.map(({ name }) => name);

        log("info", "Client", "Connected to Discord guilds", {
          guildCount: guilds.size,
          guildNames: guildNames.join(", "),
        });
      } catch (error) {
        log("error", "Client", "Failed to fetch guilds", { error });
      }

      if (client.application) {
        const { id } = client.application;
        log("info", "Client", "Discord application ready", {
          applicationId: id,
          inviteUrl: botInviteUrl({ clientId: id }),
        });
      }
    },
    {},
  ).catch((e) => {
    log("error", "Client", "Discord client login failed", {
      error: e,
      tokenPresent: !!discordToken,
    });

    process.exit(1);
  });
};
