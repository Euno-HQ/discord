import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
} from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database.ts";
import { interactionReply, sendMessage } from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import type { SlashCommand } from "#~/helpers/discord.js";
import { featureStats } from "#~/helpers/metrics";
import { DEFAULT_MESSAGE_TEXT } from "#~/helpers/setupDefaults";

export const Command = [
  {
    command: new SlashCommandBuilder()
      .setName("honeypot-setup")
      .addChannelOption((o) => {
        o.setName("channel");
        o.setDescription(
          "Which channel (if not this one) should be used for the honeypot?",
        );
        return o;
      })
      .addStringOption((o) => {
        o.setName("message-text");
        o.setDescription(
          `What should the message in the channel say? If left blank, it will provide a default`,
        );
        return o;
      })
      .setDescription("Set up a trap channel for spam bots")
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator,
      ) as SlashCommandBuilder,

    handler: (interaction) =>
      Effect.gen(function* () {
        if (!interaction.guild || !interaction.guildId) {
          yield* Effect.fail(new Error("Interaction has no guild"));
          return;
        }

        const honeypotChannel =
          interaction.options.getChannel("channel") ?? interaction.channel;
        const messageText =
          interaction.options.getString("message-text") ?? DEFAULT_MESSAGE_TEXT;

        if (!honeypotChannel?.id) {
          yield* interactionReply(interaction, {
            content: `You must provide a channel!`,
          });
          return;
        }

        if (honeypotChannel.type !== ChannelType.GuildText) {
          yield* interactionReply(interaction, {
            content: `The channel configured must be a text channel!`,
          });
          return;
        }

        const castedChannel = honeypotChannel as TextChannel;
        const db = yield* DatabaseService;
        const result = yield* db
          .insertInto("honeypot_config")
          .values({
            guild_id: interaction.guildId,
            channel_id: honeypotChannel.id,
          })
          .onConflict((c) => c.doNothing());

        if ((result[0]?.numInsertedOrUpdatedRows ?? 0) > 0) {
          yield* sendMessage(castedChannel, messageText);
          featureStats.honeypotSetup(
            interaction.guildId,
            interaction.user.id,
            honeypotChannel.id,
          );
        }

        yield* interactionReply(interaction, {
          content: "Honeypot setup completed successfully!",
          flags: [MessageFlags.Ephemeral],
        });
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect(
              "error",
              "HoneypotSetup",
              "Error during honeypot action",
              { error },
            );

            yield* interactionReply(interaction, {
              content: "Failed to setup honeypot. Please try again.",
              flags: [MessageFlags.Ephemeral],
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("honeypotSetupCommand", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies SlashCommand,
];
