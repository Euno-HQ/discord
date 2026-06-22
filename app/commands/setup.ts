import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { Effect } from "effect";

import { interactionReply } from "#~/effects/discordSdk.ts";
import { toUserResponse } from "#~/effects/errorHandling";
import { logEffect } from "#~/effects/observability.ts";
import type { SlashCommand } from "#~/helpers/discord";
import { formatError } from "#~/helpers/formatError";
import { commandStats } from "#~/helpers/metrics";

import { initSetupForm } from "./setupHandlers.ts";

export const Command = {
  command: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set up Euno for your server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  handler: (interaction) =>
    Effect.gen(function* () {
      if (!interaction.guild || !interaction.guildId) {
        yield* interactionReply(interaction, {
          content: "This command can only be used in a server.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      yield* logEffect("info", "Commands", "Setup command executed", {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.user.username,
      });

      const guildChannelIds = new Set(
        interaction.guild.channels.cache.map((c) => c.id),
      );
      const form = yield* initSetupForm(
        interaction.guildId,
        interaction.user.id,
        guildChannelIds,
      );

      yield* interactionReply(
        interaction,
        form as Parameters<typeof interaction.reply>[0],
      );

      commandStats.commandExecuted(interaction, "setup", true);
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* logEffect("error", "Commands", "Setup command failed", {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            error,
          });

          commandStats.commandFailed(interaction, "setup", formatError(error));

          const reply = toUserResponse(error);
          yield* interactionReply(interaction, {
            content: reply.content,
            flags: reply.ephemeral ? MessageFlags.Ephemeral : undefined,
          }).pipe(Effect.catchAll(() => Effect.void));
        }),
      ),
      Effect.withSpan("setupCommand", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
    ),
} satisfies SlashCommand;
