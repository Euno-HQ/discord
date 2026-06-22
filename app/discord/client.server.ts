import { ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";
import { Effect } from "effect";

import { logEffect } from "#~/effects/observability.ts";
import { botInviteUrl } from "#~/helpers/botPermissions";
import { discordToken } from "#~/helpers/env.server";
import { trackPerformance } from "#~/helpers/observability";

export const client = new Client({
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

export const login = () => {
  return trackPerformance(
    "discord_login",
    async () => {
      Effect.runFork(
        logEffect("info", "Client", "Starting Discord client login", {}),
      );

      await client.login(discordToken);

      Effect.runFork(
        logEffect("info", "Client", "Discord client login successful", {}),
      );

      client.user?.setActivity("server activity…", {
        type: ActivityType.Watching,
      });

      try {
        const guilds = await client.guilds.fetch();
        const guildNames = guilds.map(({ name }) => name);

        Effect.runFork(
          logEffect("info", "Client", "Connected to Discord guilds", {
            guildCount: guilds.size,
            guildNames: guildNames.join(", "),
          }),
        );
      } catch (error) {
        Effect.runFork(
          logEffect("error", "Client", "Failed to fetch guilds", { error }),
        );
      }

      if (client.application) {
        const { id } = client.application;
        Effect.runFork(
          logEffect("info", "Client", "Discord application ready", {
            applicationId: id,
            inviteUrl: botInviteUrl({ clientId: id }),
          }),
        );
      }
    },
    {},
  ).catch((e) => {
    Effect.runFork(
      logEffect("error", "Client", "Discord client login failed", {
        error: e,
        tokenPresent: !!discordToken,
      }),
    );

    process.exit(1);
  });
};
