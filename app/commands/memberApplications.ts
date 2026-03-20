import { Routes, TextInputStyle } from "discord-api-types/v10";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
} from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database.ts";
import { ssrDiscordSdk as rest } from "#~/discord/api";
import {
  fetchChannel,
  interactionReply,
  sendMessage,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import {
  type MessageComponentCommand,
  type ModalCommand,
} from "#~/helpers/discord";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";
import { getOrCreateUserThread } from "#~/models/userThreads";

export const Command = [
  {
    command: {
      type: InteractionType.MessageComponent,
      name: "apply-to-join",
    },
    handler: (interaction) =>
      Effect.gen(function* () {
        const modal = new ModalBuilder()
          .setCustomId("modal-apply-to-join")
          .setTitle("Apply to join this community");

        const aboutRow = new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setLabel("Tell us about yourself")
            .setCustomId("about")
            .setMinLength(20)
            .setMaxLength(500)
            .setRequired(true)
            .setStyle(TextInputStyle.Paragraph),
        );
        const referralRow = new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setLabel("How did you find this server?")
            .setCustomId("referral")
            .setMaxLength(200)
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        );
        const goalsRow = new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setLabel("What do you hope to get from this community?")
            .setCustomId("goals")
            .setMaxLength(300)
            .setRequired(true)
            .setStyle(TextInputStyle.Paragraph),
        );

        // @ts-expect-error busted types
        modal.addComponents(aboutRow, referralRow, goalsRow);

        yield* Effect.tryPromise(() => interaction.showModal(modal));
      }).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.withSpan("applyToJoinModal", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies MessageComponentCommand,

  {
    command: {
      type: InteractionType.ModalSubmit,
      name: "modal-apply-to-join",
    },
    handler: (interaction) =>
      Effect.gen(function* () {
        if (
          !interaction.channel ||
          !interaction.guild ||
          !interaction.message
        ) {
          yield* interactionReply(interaction, {
            content: "Something went wrong while submitting your application",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const { fields, user } = interaction;
        const about = fields.getTextInputValue("about");
        const referral = fields.getTextInputValue("referral");
        const goals = fields.getTextInputValue("goals");

        const db = yield* DatabaseService;
        const configRows = yield* db
          .selectFrom("application_config")
          .selectAll()
          .where("guild_id", "=", interaction.guild.id);
        const config = configRows[0];

        if (!config) {
          yield* interactionReply(interaction, {
            content:
              "Applications are not configured for this server. Please contact an administrator.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const applyChannel = yield* fetchChannel(
          interaction.guild,
          config.channel_id,
        );

        if (
          !applyChannel?.isTextBased() ||
          applyChannel.type !== ChannelType.GuildText
        ) {
          yield* interactionReply(interaction, {
            content:
              "The application channel is misconfigured. Please contact an administrator.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const thread = yield* Effect.tryPromise(() =>
          applyChannel.threads.create({
            name: `Application: ${user.username}`,
            autoArchiveDuration: 60 * 24 * 7,
            type: ChannelType.PrivateThread,
            invitable: false,
          }),
        );

        // Post application content to the applicant's private thread
        yield* sendMessage(
          thread,
          `<@${user.id}>, your application has been received. A moderator will review it shortly.\n\n` +
            `**Tell us about yourself**\n${about}\n\n` +
            `**How did you find this server?**\n${referral}\n\n` +
            `**What do you hope to get from this community?**\n${goals}`,
        );

        // Post review message with approve/deny buttons to the mod-log user thread
        const modThread = yield* getOrCreateUserThread(interaction.guild, user);

        const applicationContent =
          `**Application from ${user.displayName} (<@${user.id}>)**\n\n` +
          `**Tell us about yourself**\n${about}\n\n` +
          `**How did you find this server?**\n${referral}\n\n` +
          `**What do you hope to get from this community?**\n${goals}`;

        yield* sendMessage(modThread, applicationContent);

        yield* sendMessage(modThread, {
          content: "Review this application:",
          components: [
            // @ts-expect-error Types for this are super busted
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`app-approve||${user.id}`)
                .setLabel("Approve")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`app-deny||${user.id}`)
                .setLabel("Deny")
                .setStyle(ButtonStyle.Danger),
            ),
          ],
        });

        yield* interactionReply(interaction, {
          content:
            "Your application has been submitted! A moderator will review it shortly.",
          flags: MessageFlags.Ephemeral,
        });
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect(
              "error",
              "MemberApplication",
              "Error submitting application",
              { error },
            );

            yield* interactionReply(interaction, {
              content: "Something went wrong while submitting your application",
              flags: MessageFlags.Ephemeral,
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("modalApplyToJoin", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies ModalCommand,

  {
    command: {
      type: InteractionType.MessageComponent,
      name: "app-approve",
    },
    handler: (interaction) =>
      Effect.gen(function* () {
        const [, applicantUserId] = interaction.customId.split("||");

        if (!interaction.guild || !interaction.member) {
          yield* interactionReply(interaction, {
            content: "Something went wrong",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guildId = interaction.guild.id;
        const approverId = interaction.user.id;

        const db = yield* DatabaseService;
        const configRows = yield* db
          .selectFrom("application_config")
          .selectAll()
          .where("guild_id", "=", guildId);
        const config = configRows[0];

        if (!config) {
          yield* interactionReply(interaction, {
            content: "Application config not found for this server.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        yield* Effect.tryPromise(() =>
          rest.put(
            Routes.guildMemberRole(guildId, applicantUserId, config.role_id),
          ),
        );

        yield* interactionReply(interaction, {
          content: `<@${applicantUserId}>'s application has been approved by <@${approverId}>. Welcome to the community!`,
          allowedMentions: {},
        });

        const { [SETTINGS.modLog]: modLog } = yield* fetchSettingsEffect(
          guildId,
          [SETTINGS.modLog],
        );

        yield* Effect.tryPromise(() =>
          rest.post(Routes.channelMessages(modLog), {
            body: {
              content: `<@${applicantUserId}>'s application approved by <@${approverId}> in <#${interaction.channelId}>`,
              allowedMentions: {},
            },
          }),
        );

        yield* Effect.tryPromise(() =>
          rest.patch(Routes.channel(interaction.channelId), {
            body: { archived: true, locked: true },
          }),
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect(
              "error",
              "MemberApplication",
              "Error approving application",
              { error },
            );

            yield* interactionReply(interaction, {
              content: "Something went wrong while approving the application",
              flags: MessageFlags.Ephemeral,
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("appApprove", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies MessageComponentCommand,

  {
    command: {
      type: InteractionType.MessageComponent,
      name: "app-deny",
    },
    handler: (interaction) =>
      Effect.gen(function* () {
        const [, applicantUserId] = interaction.customId.split("||");

        if (!interaction.guild || !interaction.member) {
          yield* interactionReply(interaction, {
            content: "Something went wrong",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guildId = interaction.guild.id;
        const denierId = interaction.user.id;

        yield* interactionReply(interaction, {
          content: `<@${applicantUserId}>'s application has been denied by <@${denierId}>.`,
          allowedMentions: {},
        });

        const { [SETTINGS.modLog]: modLog } = yield* fetchSettingsEffect(
          guildId,
          [SETTINGS.modLog],
        );

        yield* Effect.tryPromise(() =>
          rest.post(Routes.channelMessages(modLog), {
            body: {
              content: `<@${applicantUserId}>'s application denied by <@${denierId}> in <#${interaction.channelId}>`,
              allowedMentions: {},
            },
          }),
        );

        yield* Effect.tryPromise(() =>
          rest.patch(Routes.channel(interaction.channelId), {
            body: { archived: true, locked: true },
          }),
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect(
              "error",
              "MemberApplication",
              "Error denying application",
              { error },
            );

            yield* interactionReply(interaction, {
              content: "Something went wrong while denying the application",
              flags: MessageFlags.Ephemeral,
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("appDeny", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies MessageComponentCommand,
];
