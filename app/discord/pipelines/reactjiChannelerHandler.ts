import { Effect } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";
import type { MessageReactionAddEvent } from "#~/discord/events";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import { logEffect } from "#~/effects/observability";
import { featureStats } from "#~/helpers/metrics";

export const handleReactionAdd = (
  e: MessageReactionAddEvent,
): Effect.Effect<void, never, RuntimeContext> =>
  Effect.gen(function* () {
    // Fetch partial reaction if needed
    const reaction = e.reaction.partial
      ? yield* tryDiscord("fetchReaction", () => e.reaction.fetch())
      : e.reaction;

    // Skip bot reactions
    if (e.user.bot) {
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
    const db = yield* DatabaseService;
    const configs = yield* db
      .selectFrom("reactji_channeler_config")
      .selectAll()
      .where("guild_id", "=", guildId)
      .where("emoji", "=", emoji);

    const config = configs[0];

    if (!config) {
      return;
    }

    // Check if reaction count matches the configured threshold
    if (reaction.count !== config.threshold) {
      return;
    }

    yield* logEffect("info", "ReactjiChanneler", "Forwarding message", {
      messageId: message.id,
      channelId: config.channel_id,
      emoji,
      guildId,
      threshold: config.threshold,
    });

    // Fetch the target channel
    const targetChannel = yield* tryDiscord("fetchTargetChannel", () =>
      message.guild!.channels.fetch(config.channel_id),
    );

    if (!targetChannel?.isTextBased()) {
      yield* logEffect(
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
    const fullMessage = message.partial
      ? yield* tryDiscord("fetchFullMessage", () => message.fetch())
      : message;

    // Forward the message using Discord's native forwarding
    yield* tryDiscord("forwardMessage", () =>
      fullMessage.forward(targetChannel),
    );

    // Get all users who reacted with this emoji
    const reactors = yield* tryDiscord("fetchReactors", () =>
      reaction.users.fetch(),
    );

    const reactorMentions = reactors
      .filter((u) => !u.bot)
      .map((u) => `<@${u.id}>`)
      .join(", ");

    // Send a message indicating who triggered the forward
    yield* tryDiscord("sendForwardSummary", () =>
      targetChannel.send({
        content: `Forwarded by ${reactorMentions} reacting with ${emoji}`,
        allowedMentions: { users: [] },
      }),
    );

    featureStats.reactjiTriggered(guildId, e.user.id, emoji, message.id);

    yield* logEffect(
      "info",
      "ReactjiChanneler",
      "Message forwarded successfully",
      {
        messageId: message.id,
        targetChannelId: config.channel_id,
        emoji,
        triggeredBy: e.user.id,
      },
    );
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "ReactjiChanneler", "Pipeline handler failed", {
        messageId: e.reaction.message.id,
        error: err,
      }),
    ),
    Effect.withSpan("ReactjiChanneler.reactionAdd"),
  );
