import { ApplicationCommandType } from "discord-api-types/v10";
import {
  ContextMenuCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { Effect } from "effect";

import { logUserMessage } from "#~/commands/report/userLog.ts";
import {
  interactionDeferReply,
  interactionEditReply,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import type { MessageContextCommand } from "#~/helpers/discord";
import { commandStats } from "#~/helpers/metrics";
import { ReportReasons } from "#~/models/reportedMessages.ts";

export const Command = {
  command: new ContextMenuCommandBuilder()
    .setName("Report")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),
  handler: (interaction) =>
    Effect.gen(function* () {
      const { targetMessage: message } = interaction;

      yield* interactionDeferReply(interaction, {
        flags: [MessageFlags.Ephemeral],
      });

      yield* logEffect("info", "Commands", "Report command executed");

      yield* logUserMessage({
        reason: ReportReasons.anonReport,
        message,
        staff: false,
      });

      yield* logEffect("info", "Commands", "Report submitted successfully");

      commandStats.reportSubmitted(interaction, message.author.id);
      commandStats.commandExecuted(interaction, "report", true);

      yield* interactionEditReply(interaction, {
        content: "This message has been reported anonymously",
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* logEffect("error", "Commands", "Report command failed", {
            error,
          });

          yield* interactionEditReply(interaction, {
            content: "Failed to submit report. Please try again later.",
          }).pipe(
            Effect.catch(() => {
              commandStats.commandFailed(interaction, "report", error.message);
              return Effect.void;
            }),
          );
        }),
      ),
      Effect.withSpan("reportCommand", {
        attributes: {
          guildId: interaction.guildId,
          reporterUserId: interaction.user.id,
          targetUserId: interaction.targetMessage.author.id,
          targetMessageId: interaction.targetMessage.id,
          reason: ReportReasons.anonReport,
          channelId: interaction.channelId,
        },
      }),
    ),
} satisfies MessageContextCommand;
