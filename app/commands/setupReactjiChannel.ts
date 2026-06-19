import { randomUUID } from "crypto";
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database.ts";
import { interactionReply } from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import type { SlashCommand } from "#~/helpers/discord";
import { featureStats } from "#~/helpers/metrics";

import { resolveReactjiEmoji } from "./reactjiEmoji.ts";

export const Command = {
  command: new SlashCommandBuilder()
    .setName("setup-reactji-channel")
    .addStringOption((o) => {
      o.setName("emoji");
      o.setDescription(
        "The emoji that will trigger forwarding to this channel",
      );
      o.setRequired(true);
      return o;
    })
    .addIntegerOption((o) => {
      o.setName("threshold");
      o.setDescription(
        "How many reactions are needed to trigger forwarding (default: 1)",
      );
      o.setMinValue(1);
      o.setRequired(false);
      return o;
    })
    .setDescription(
      "Configure an emoji to forward reacted messages to this channel",
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    ) as SlashCommandBuilder,

  handler: (interaction) =>
    Effect.gen(function* () {
      if (!interaction.guild) {
        yield* interactionReply(interaction, {
          content: "This command can only be used in a server.",
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      const emojiInput = interaction.options.getString("emoji", true);
      const threshold = interaction.options.getInteger("threshold") ?? 1;
      const channelId = interaction.channelId;
      const guildId = interaction.guild.id;
      const configuredById = interaction.user.id;

      // Resolve the emoji to a value the channeler can actually match against:
      // a custom-emoji mention or a unicode character. Reject shortcodes/text
      // that could never match a real reaction (#371).
      const resolution = resolveReactjiEmoji(
        emojiInput,
        interaction.guild.emojis.cache.map((e) => ({
          name: e.name,
          id: e.id,
          animated: e.animated ?? false,
        })),
      );

      if (!resolution.ok) {
        yield* interactionReply(interaction, {
          content: resolution.error,
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }
      const emoji = resolution.value;

      // Upsert: update if exists, insert if not
      const db = yield* DatabaseService;
      yield* db
        .insertInto("reactji_channeler_config")
        .values({
          id: randomUUID(),
          guild_id: guildId,
          channel_id: channelId,
          emoji,
          configured_by_id: configuredById,
          threshold,
        })
        .onConflict((oc) =>
          oc.columns(["guild_id", "emoji"]).doUpdateSet({
            channel_id: channelId,
            configured_by_id: configuredById,
            threshold,
          }),
        );

      featureStats.reactjiChannelSetup(
        guildId,
        configuredById,
        emoji,
        threshold,
      );

      const thresholdText =
        threshold === 1 ? "" : ` (after ${threshold} reactions)`;
      yield* interactionReply(interaction, {
        content: `Configured by <@${configuredById}>: messages reacted with ${emoji} will be forwarded to this channel${thresholdText}.`,
      });
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* logEffect(
            "error",
            "Commands",
            "Error configuring reactji channeler",
            { error },
          );

          yield* interactionReply(interaction, {
            content:
              "Something went wrong while configuring the reactji channeler.",
            flags: [MessageFlags.Ephemeral],
          }).pipe(Effect.catchAll(() => Effect.void));
        }),
      ),
      Effect.withSpan("setupReactjiChannelCommand", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          channelId: interaction.channelId,
        },
      }),
    ),
} satisfies SlashCommand;
