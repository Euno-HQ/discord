import { ApplicationCommandType } from "discord-api-types/v10";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContextMenuCommandBuilder,
  InteractionType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { Effect } from "effect";

import { logUserMessage } from "#~/commands/report/userLog.ts";
import { DiscordClient } from "#~/discord/client.server";
import {
  deleteMessage,
  fetchChannelFromClient,
  fetchMessage,
  interactionDeferReply,
  interactionEditReply,
  interactionUpdate,
  messageReply,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import type {
  MessageComponentCommand,
  MessageContextCommand,
} from "#~/helpers/discord";
import { featureStats } from "#~/helpers/metrics";
import {
  getReportById,
  markMessageAsDeleted,
  ReportReasons,
} from "#~/models/reportedMessages";

export const Command = [
  {
    command: new ContextMenuCommandBuilder()
      .setName("Track")
      .setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    handler: (interaction) =>
      Effect.gen(function* () {
        // Defer immediately to avoid 3-second timeout - creating threads can take time
        yield* interactionDeferReply(interaction, {
          flags: [MessageFlags.Ephemeral],
        });

        const { targetMessage: message, user } = interaction;

        if (interaction.guildId) {
          featureStats.userTracked(
            interaction.guildId,
            user.id,
            message.author.id,
          );
        }

        const { reportId, thread } = yield* logUserMessage({
          reason: ReportReasons.track,
          message,
          staff: user,
        });

        yield* interactionEditReply(interaction, {
          content: `Tracked <#${thread.id}>`,
          components: reportId
            ? [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`delete-tracked|${reportId}`)
                    .setLabel("Delete message")
                    .setStyle(ButtonStyle.Danger),
                ),
              ]
            : [],
        });
      }).pipe(
        Effect.catchAll((error) =>
          Effect.all([
            logEffect("error", "Track", "Error tracking message", {
              error,
            }),
            interactionEditReply(interaction, {
              content: "Failed to track message",
            }).pipe(Effect.catchAll(() => Effect.void)),
          ]),
        ),
      ),
  } satisfies MessageContextCommand,
  {
    command: { type: InteractionType.MessageComponent, name: "delete-tracked" },
    handler: (interaction) =>
      Effect.gen(function* () {
        const client = yield* DiscordClient;
        const [, reportId] = interaction.customId.split("|");

        const report = yield* getReportById(reportId);

        if (!report) {
          yield* interactionUpdate(interaction, {
            content: "Report not found",
            components: [],
          });
          return;
        }

        const channel = yield* fetchChannelFromClient(
          client,
          report.reported_channel_id,
        );
        const originalMessage = yield* fetchMessage(
          channel,
          report.reported_message_id,
        );
        yield* deleteMessage(originalMessage);

        yield* markMessageAsDeleted(
          report.reported_message_id,
          report.guild_id,
        );

        const logChannel = yield* fetchChannelFromClient(
          client,
          report.log_channel_id,
        );
        const logMessage = yield* fetchMessage(
          logChannel,
          report.log_message_id,
        );
        yield* messageReply(logMessage, {
          allowedMentions: { users: [] },
          content: `deleted by ${interaction.user.username}`,
        }).pipe(Effect.catchAll(() => Effect.void));

        yield* interactionUpdate(interaction, {
          content: `Tracked <#${report.log_channel_id}>`,
          components: [],
        });
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect(
              "error",
              "Track",
              "Error deleting tracked message",
              { error },
            );
            yield* interactionUpdate(interaction, {
              content: "Failed to delete message",
              components: [],
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
      ),
  } satisfies MessageComponentCommand,
];
