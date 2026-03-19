import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";

import { interactionReply } from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import type { SlashCommand } from "#~/helpers/discord";
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
        // @effect-diagnostics-next-line globalErrorInEffectFailure:off
        return yield* Effect.fail(new Error("Interaction has no guild"));
      }

      yield* logEffect("info", "Commands", "Setup command executed", {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.user.username,
      });

      const form = yield* Effect.tryPromise(() =>
        initSetupForm(interaction.guildId!, interaction.user.id),
      );

      yield* interactionReply(
        interaction,
        form as Parameters<typeof interaction.reply>[0],
      );

      commandStats.commandExecuted(interaction, "setup", true);
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const err = error instanceof Error ? error : new Error(String(error));

          yield* logEffect("error", "Commands", "Setup command failed", {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            error: err,
          });

          commandStats.commandFailed(interaction, "setup", err.message);

          yield* interactionReply(
            interaction,
            `Something broke:\n\`\`\`\n${err.toString()}\n\`\`\``,
          ).pipe(Effect.catchAll(() => Effect.void));
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
