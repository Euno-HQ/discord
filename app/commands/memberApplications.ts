import { ButtonStyle, Routes, TextInputStyle } from "discord-api-types/v10";
import {
  ActionRowBuilder,
  ChannelType,
  ComponentType,
  InteractionType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
} from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database.ts";
import { ssrDiscordSdk as rest } from "#~/discord/api";
import { fetchChannel, interactionReply } from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import {
  quoteMessageContent,
  type MessageComponentCommand,
  type ModalCommand,
} from "#~/helpers/discord";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";
import { getOrCreateUserThread } from "#~/models/userThreads";

function pendingLabel(count: number): string {
  if (count === 0) return "apply-here";
  return `apply-here⎸${count}-pending`;
}

/** Update the #apply-here channel name to reflect the current pending count. */
const syncChannelName = (guildId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const [row] = yield* db
      .selectFrom("applications")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("guild_id", "=", guildId)
      .where("status", "=", "pending");

    const count = Number(row?.count ?? 0);

    const [config] = yield* db
      .selectFrom("application_config")
      .select("channel_id")
      .where("guild_id", "=", guildId);

    if (!config) return;

    yield* Effect.tryPromise(() =>
      rest.patch(Routes.channel(config.channel_id), {
        body: { name: pendingLabel(count) },
      }),
    );
  }).pipe(
    // Channel rename is cosmetic — don't fail the main operation
    Effect.catchAll(() => Effect.void),
  );

export const Command = [
  {
    command: {
      type: InteractionType.MessageComponent,
      name: "apply-to-join",
    },
    handler: (interaction) =>
      Effect.gen(function* () {
        // Block duplicate applications before showing the modal
        const db = yield* DatabaseService;
        const existingApp = yield* db
          .selectFrom("applications")
          .selectAll()
          .where("guild_id", "=", interaction.guildId!)
          .where("user_id", "=", interaction.user.id)
          .where("status", "=", "pending");

        if (existingApp[0]) {
          yield* interactionReply(interaction, {
            content:
              "You already have a pending application. Please wait for a moderator to review it.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

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

        // Record the application in the database
        yield* db.insertInto("applications").values({
          id: crypto.randomUUID(),
          guild_id: interaction.guild.id,
          user_id: user.id,
          thread_id: thread.id,
          status: "pending",
          created_at: new Date().toISOString(),
        });

        const applicationComponents = [
          {
            type: ComponentType.TextDisplay,
            content: `Tell us about yourself\n${quoteMessageContent(about)}`,
          },
          {
            type: ComponentType.TextDisplay,
            content: `How did you find this server?\n${quoteMessageContent(referral)}`,
          },
          {
            type: ComponentType.TextDisplay,
            content: `What do you hope to get from this community?\n${quoteMessageContent(goals)}`,
          },
        ];

        // Post application receipt to the applicant's private thread
        yield* Effect.tryPromise(() =>
          rest.post(Routes.channelMessages(thread.id), {
            body: {
              flags: MessageFlags.IsComponentsV2,
              components: [
                {
                  type: ComponentType.Container,
                  components: [
                    {
                      type: ComponentType.TextDisplay,
                      content: `<@${user.id}>, your application has been received. A moderator will review it shortly.`,
                    },
                    { type: ComponentType.Separator },
                    ...applicationComponents,
                  ],
                },
              ],
            },
          }),
        );

        // Post review message with approve/deny buttons to the mod-log user thread
        const modThread = yield* getOrCreateUserThread(interaction.guild, user);

        yield* Effect.tryPromise(() =>
          rest.post(Routes.channelMessages(modThread.id), {
            body: {
              flags: MessageFlags.IsComponentsV2,
              components: [
                {
                  type: ComponentType.Container,
                  components: [
                    {
                      type: ComponentType.TextDisplay,
                      content: `## Application from ${user.displayName}\nApplicant thread: <#${thread.id}>`,
                    },
                    { type: ComponentType.Separator },
                    ...applicationComponents,
                    { type: ComponentType.Separator },
                    {
                      type: ComponentType.ActionRow,
                      components: [
                        {
                          type: ComponentType.Button,
                          custom_id: `app-approve||${user.id}`,
                          label: "Approve",
                          style: ButtonStyle.Success,
                        },
                        {
                          type: ComponentType.Button,
                          custom_id: `app-deny||${user.id}`,
                          label: "Deny",
                          style: ButtonStyle.Danger,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );

        yield* interactionReply(interaction, {
          content:
            "Your application has been submitted! A moderator will review it shortly.",
          flags: MessageFlags.Ephemeral,
        });

        yield* syncChannelName(interaction.guild.id);
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

        yield* db
          .updateTable("applications")
          .set({
            status: "approved",
            reviewed_by: approverId,
            resolved_at: new Date().toISOString(),
          })
          .where("guild_id", "=", guildId)
          .where("user_id", "=", applicantUserId)
          .where("status", "=", "pending");

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

        yield* syncChannelName(guildId);
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

        const db = yield* DatabaseService;
        yield* db
          .updateTable("applications")
          .set({
            status: "denied",
            reviewed_by: denierId,
            resolved_at: new Date().toISOString(),
          })
          .where("guild_id", "=", guildId)
          .where("user_id", "=", applicantUserId)
          .where("status", "=", "pending");

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

        yield* syncChannelName(guildId);
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
