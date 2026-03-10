import { ApplicationCommandType } from "discord-api-types/v10";
import {
  ActionRowBuilder,
  ChannelType,
  ContextMenuCommandBuilder,
  InteractionType,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { Effect } from "effect";

import {
  interactionDeferUpdate,
  interactionEditReply,
  interactionReply,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import type {
  MessageComponentCommand,
  UserContextCommand,
} from "#~/helpers/discord";
import { commandStats } from "#~/helpers/metrics";

// Duration options mirror Discord's "delete messages on ban" increments.
const DURATION_OPTIONS = [
  {
    label: "1 hour",
    value: "3600",
    description: "Delete messages from the last hour",
  },
  {
    label: "6 hours",
    value: "21600",
    description: "Delete messages from the last 6 hours",
  },
  {
    label: "12 hours",
    value: "43200",
    description: "Delete messages from the last 12 hours",
  },
  {
    label: "24 hours",
    value: "86400",
    description: "Delete messages from the last 24 hours",
  },
  {
    label: "3 days",
    value: "259200",
    description: "Delete messages from the last 3 days",
  },
  {
    label: "7 days",
    value: "604800",
    description: "Delete messages from the last 7 days",
  },
] as const;

/**
 * "Purge recent messages" — User context menu command.
 * Responds with an ephemeral select menu asking how far back to purge.
 * The target user ID is embedded in the select menu's custom_id so the
 * follow-up handler knows who to purge without additional state.
 */
export const PurgeMessagesCommand = {
  command: new ContextMenuCommandBuilder()
    .setName("Purge recent messages")
    .setType(ApplicationCommandType.User)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  handler: (interaction) =>
    Effect.gen(function* () {
      const { targetUser, guild } = interaction;

      yield* logEffect("info", "Commands", "Purge messages command invoked", {
        guildId: interaction.guildId,
        moderatorUserId: interaction.user.id,
        targetUserId: targetUser.id,
        targetUsername: targetUser.username,
      });

      if (!guild) {
        yield* interactionReply(interaction, {
          flags: MessageFlags.Ephemeral,
          content: "This command can only be used in a guild.",
        });
        return;
      }

      const selectMenu = new StringSelectMenuBuilder()
        // Embed the target user ID in the custom_id so the follow-up handler
        // can identify who to purge. matchCommand() resolves "purge-messages|<id>"
        // via the startsWith prefix match.
        .setCustomId(`purge-messages|${targetUser.id}`)
        .setPlaceholder("Select how far back to purge")
        .addOptions(
          DURATION_OPTIONS.map((opt) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(opt.label)
              .setValue(opt.value)
              .setDescription(opt.description),
          ),
        );

      const row =
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          selectMenu,
        );

      commandStats.commandExecuted(interaction, "purge-messages", true);

      yield* interactionReply(interaction, {
        flags: MessageFlags.Ephemeral,
        content: `How far back should I purge messages from **${targetUser.username}**?`,
        components: [row],
      });
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const err = error instanceof Error ? error : new Error(String(error));
          yield* logEffect("error", "Commands", "Purge messages invoke failed", {
            guildId: interaction.guildId,
            moderatorUserId: interaction.user.id,
            targetUserId: interaction.targetUser.id,
            error: err.message,
          });
          commandStats.commandFailed(
            interaction,
            "purge-messages",
            err.message,
          );
        }),
      ),
      Effect.withSpan("purgeMessagesCommand", {
        attributes: {
          guildId: interaction.guildId,
          moderatorUserId: interaction.user.id,
          targetUserId: interaction.targetUser.id,
        },
      }),
    ),
} satisfies UserContextCommand;

/**
 * Select menu handler for "purge-messages|<targetUserId>".
 * Defers the update immediately, then scans every text channel and active
 * thread in the guild, bulk-deleting messages authored by the target user
 * within the selected duration window. Edits the original reply on completion.
 */
export const PurgeMessagesSelectHandler = {
  command: {
    type: InteractionType.MessageComponent,
    name: "purge-messages",
  } as const,
  handler: (interaction) =>
    Effect.gen(function* () {
      if (!interaction.isStringSelectMenu()) return;

      // Extract the target user ID that was embedded in the custom_id.
      const [, targetUserId] = interaction.customId.split("|");
      const durationSeconds = parseInt(interaction.values[0], 10);
      const durationLabel =
        DURATION_OPTIONS.find((o) => o.value === String(durationSeconds))
          ?.label ?? `${durationSeconds}s`;
      const since = Date.now() - durationSeconds * 1000;

      yield* logEffect("info", "Commands", "Purge messages select submitted", {
        guildId: interaction.guildId,
        moderatorUserId: interaction.user.id,
        targetUserId,
        durationLabel,
      });

      // Acknowledge the interaction immediately — the deletion loop may take time.
      yield* interactionDeferUpdate(interaction);

      const guild = interaction.guild;
      if (!guild) {
        yield* interactionEditReply(interaction, {
          content: "Could not find the guild — no messages were deleted.",
          components: [],
        });
        return;
      }

      let deletedCount = 0;

      // Collect all text channels and active threads.
      const textChannels = guild.channels.cache.filter(
        (ch) =>
          ch.type === ChannelType.GuildText ||
          ch.type === ChannelType.GuildAnnouncement ||
          ch.type === ChannelType.GuildForum,
      );

      // Also include active threads (public and private).
      const activeThreads = yield* Effect.tryPromise(() =>
        guild.channels.fetchActiveThreads(),
      ).pipe(Effect.orElseSucceed(() => ({ threads: new Map() })));

      const channelsToScan = [
        ...textChannels.values(),
        ...activeThreads.threads.values(),
      ];

      // Scan channels in an async function so we can use await + per-channel
      // try/catch to gracefully skip channels the bot cannot access.
      yield* Effect.tryPromise(async () => {
        for (const channel of channelsToScan) {
          if (!channel.isTextBased()) continue;
          try {
            let lastId: string | undefined;

            // Paginate through channel history oldest-first within the window.
            for (;;) {
              const messages = await channel.messages.fetch({
                limit: 100,
                ...(lastId ? { before: lastId } : {}),
              });

              if (messages.size === 0) break;

              // Filter messages from this user within the time window.
              const toDelete = messages.filter(
                (m) =>
                  m.author.id === targetUserId && m.createdTimestamp >= since,
              );

              if (toDelete.size > 0) {
                if (toDelete.size === 1) {
                  await toDelete.first()!.delete();
                } else {
                  // bulkDelete requires messages < 2 weeks old; our max window
                  // is 7 days so this is always safe.
                  await channel.bulkDelete(toDelete);
                }
                deletedCount += toDelete.size;
              }

              // Stop paging if we've gone past the time window.
              const oldest = messages.last();
              if (!oldest || oldest.createdTimestamp < since) break;
              lastId = oldest.id;
            }
          } catch {
            // Skip channels the bot lacks permission to read/manage.
            // This is expected for some channels and should not abort the whole run.
          }
        }
      });

      yield* logEffect(
        "info",
        "Commands",
        "Purge messages completed",
        {
          guildId: interaction.guildId,
          moderatorUserId: interaction.user.id,
          targetUserId,
          durationLabel,
          deletedCount,
        },
      );

      yield* interactionEditReply(interaction, {
        content: `Done. Deleted **${deletedCount}** message${deletedCount !== 1 ? "s" : ""} from <@${targetUserId}> in the last ${durationLabel}.`,
        components: [],
      });
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const err = error instanceof Error ? error : new Error(String(error));
          yield* logEffect(
            "error",
            "Commands",
            "Purge messages select handler failed",
            {
              guildId: interaction.guildId,
              moderatorUserId: interaction.user.id,
              error: err.message,
            },
          );
          yield* interactionEditReply(interaction, {
            content: "Something went wrong while purging messages.",
            components: [],
          }).pipe(Effect.catchAll(() => Effect.void));
        }),
      ),
      Effect.withSpan("purgeMessagesSelect", {
        attributes: {
          guildId: interaction.guildId,
          moderatorUserId: interaction.user.id,
        },
      }),
    ),
} satisfies MessageComponentCommand;

export const PurgeMessagesCommands = [
  PurgeMessagesCommand,
  PurgeMessagesSelectHandler,
];
