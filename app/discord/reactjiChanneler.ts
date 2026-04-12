import { Events, type Client } from "discord.js";

import { runEffect } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";
import { Effect } from "effect";
import { featureStats } from "#~/helpers/metrics";
import { log } from "#~/helpers/observability";

export async function startReactjiChanneler(client: Client) {
  log("info", "ReactjiChanneler", "Starting reactji channeler", {});

  client.on(Events.MessageReactionAdd, async (partialReaction, user) => {
    try {
      // Fetch partial reaction if needed
      const reaction = partialReaction.partial
        ? await partialReaction.fetch()
        : partialReaction;

      // Skip bot reactions
      if (user.bot) {
        return;
      }

      const message = reaction.message;

      // Skip if not in a guild
      if (!message.guild) {
        return;
      }

      const guildId = message.guild.id;

      // Determine emoji identifier
      // For custom emojis: <:name:id> or <a:name:id> for animated
      // For unicode emojis: just the emoji character
      const emoji = reaction.emoji.id
        ? `<${reaction.emoji.animated ? "a" : ""}:${reaction.emoji.name}:${reaction.emoji.id}>`
        : reaction.emoji.name;

      if (!emoji) {
        return;
      }

      // Look up config for this guild + emoji combination
      const config = await runEffect(
        Effect.gen(function* () {
          const db = yield* DatabaseService;
          const rows = yield* db
            .selectFrom("reactji_channeler_config")
            .selectAll()
            .where("guild_id", "=", guildId)
            .where("emoji", "=", emoji);
          return rows[0] ?? null;
        }),
      );

      if (!config) {
        return;
      }

      // Check if reaction count matches the configured threshold
      if (reaction.count !== config.threshold) {
        return;
      }

      log("info", "ReactjiChanneler", "Forwarding message", {
        messageId: message.id,
        channelId: config.channel_id,
        emoji,
        guildId,
        threshold: config.threshold,
      });

      // Fetch the target channel
      const targetChannel = await message.guild.channels.fetch(
        config.channel_id,
      );

      if (!targetChannel?.isTextBased()) {
        log(
          "error",
          "ReactjiChanneler",
          "Target channel not found or invalid",
          {
            channelId: config.channel_id,
            guildId,
          },
        );
        return;
      }

      // Fetch the full message if partial
      const fullMessage = message.partial ? await message.fetch() : message;

      // Forward the message using Discord's native forwarding
      await fullMessage.forward(targetChannel);

      // Get all users who reacted with this emoji
      const reactors = await reaction.users.fetch();
      const reactorMentions = reactors
        .filter((u) => !u.bot)
        .map((u) => `<@${u.id}>`)
        .join(", ");

      // Send a message indicating who triggered the forward
      await targetChannel.send({
        content: `Forwarded by ${reactorMentions} reacting with ${emoji}`,
        allowedMentions: { users: [] },
      });

      featureStats.reactjiTriggered(guildId, user.id, emoji, message.id);

      log("info", "ReactjiChanneler", "Message forwarded successfully", {
        messageId: message.id,
        targetChannelId: config.channel_id,
        emoji,
        triggeredBy: user.id,
      });
    } catch (error) {
      log("error", "ReactjiChanneler", "Error handling reaction", {
        error,
        messageId: partialReaction.message.id,
      });
    }
  });
}
