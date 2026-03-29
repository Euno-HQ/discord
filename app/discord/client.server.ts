import { ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";

import { botInviteUrl } from "#~/helpers/botPermissions";
import { discordToken } from "#~/helpers/env.server";
import { log, trackPerformance } from "#~/helpers/observability";

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
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      tokenPresent: !!discordToken,
    });

    process.exit(1);
  });
};
