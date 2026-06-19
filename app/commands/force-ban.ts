import { ApplicationCommandType } from "discord-api-types/v10";
import {
  ContextMenuCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { Effect } from "effect";

import { tryDiscord } from "#~/effects/classifyDiscordError";
import { interactionReply } from "#~/effects/discordSdk.ts";
import { toUserResponse } from "#~/effects/errorHandling";
import { logEffect } from "#~/effects/observability.ts";
import type { UserContextCommand } from "#~/helpers/discord";
import { formatError } from "#~/helpers/formatError";
import { commandStats } from "#~/helpers/metrics";

export const Command = {
  command: new ContextMenuCommandBuilder()
    .setName("Force Ban")
    .setType(ApplicationCommandType.User)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  handler: (interaction) =>
    Effect.gen(function* () {
      const { targetUser, guild, user } = interaction;

      yield* logEffect("info", "Commands", "Force ban command executed", {
        guildId: interaction.guildId,
        moderatorUserId: user.id,
        targetUserId: targetUser.id,
        targetUsername: targetUser.username,
      });

      if (!guild?.bans) {
        yield* logEffect(
          "error",
          "Commands",
          "No guild found on force ban interaction",
          {
            guildId: interaction.guildId,
            moderatorUserId: user.id,
            targetUserId: targetUser.id,
          },
        );

        commandStats.commandFailed(interaction, "force-ban", "No guild found");

        yield* interactionReply(interaction, {
          flags: [MessageFlags.Ephemeral],
          content: "Failed to ban user, couldn't find guild",
        });
        return;
      }

      yield* tryDiscord("forceBan", () =>
        guild.bans.create(targetUser, {
          reason: "Force banned by staff",
        }),
      );

      yield* logEffect("info", "Commands", "User force banned successfully", {
        guildId: interaction.guildId,
        moderatorUserId: user.id,
        targetUserId: targetUser.id,
        targetUsername: targetUser.username,
        reason: "Force banned by staff",
      });

      commandStats.commandExecuted(interaction, "force-ban", true);

      yield* interactionReply(interaction, {
        flags: [MessageFlags.Ephemeral],
        content: "This member has been banned",
      });
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* logEffect("error", "Commands", "Force ban failed", {
            guildId: interaction.guildId,
            moderatorUserId: interaction.user.id,
            targetUserId: interaction.targetUser.id,
            targetUsername: interaction.targetUser.username,
            error,
          });

          commandStats.commandFailed(
            interaction,
            "force-ban",
            formatError(error),
          );

          const reply = toUserResponse(error);
          yield* interactionReply(interaction, {
            content: reply.content,
            flags: reply.ephemeral ? MessageFlags.Ephemeral : undefined,
          }).pipe(Effect.catchAll(() => Effect.void));
        }),
      ),
      Effect.withSpan("forceBanCommand", {
        attributes: {
          guildId: interaction.guildId,
          moderatorUserId: interaction.user.id,
          targetUserId: interaction.targetUser.id,
        },
      }),
    ),
} satisfies UserContextCommand;
