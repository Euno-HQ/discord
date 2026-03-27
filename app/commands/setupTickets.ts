import { format } from "date-fns";
import { Routes, TextInputStyle } from "discord-api-types/v10";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
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
  quoteMessageContent,
  type MessageComponentCommand,
  type ModalCommand,
  type SlashCommand,
} from "#~/helpers/discord";
import { featureStats } from "#~/helpers/metrics";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";

export const DEFAULT_BUTTON_TEXT = "Open a private ticket with the moderators";

export const Command = [
  {
    command: new SlashCommandBuilder()
      .setName("tickets-channel")
      .addRoleOption((o) => {
        o.setName("role");
        o.setDescription(
          "Which role (if any) should be pinged when a ticket is created?",
        );
        o.setRequired(false);
        return o;
      })
      .addStringOption((o) => {
        o.setName("button-text");
        o.setDescription(
          `What should the button say? If left blank, it will say "${DEFAULT_BUTTON_TEXT}"`,
        );
        return o;
      })
      .addChannelOption((o) => {
        o.setName("channel");
        o.setDescription(
          "Which channel (if not this one) should tickets be created in?",
        );
        return o;
      })
      .setDescription(
        "Set up a new button for creating private tickets with moderators",
      )
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator,
      ) as SlashCommandBuilder,

    handler: (interaction) =>
      Effect.gen(function* () {
        if (!interaction.guild) {
          yield* Effect.fail(new Error("Interaction has no guild"));
          return;
        }

        const pingableRole = interaction.options.getRole("role");
        const ticketChannel = interaction.options.getChannel("channel");
        const buttonText =
          interaction.options.getString("button-text") ?? DEFAULT_BUTTON_TEXT;

        if (ticketChannel && ticketChannel.type !== ChannelType.GuildText) {
          yield* interactionReply(interaction, {
            content: `The channel configured must be a text channel! Tickets will be created as private threads.`,
          });
          return;
        }

        const interactionResponse = yield* interactionReply(interaction, {
          components: [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  label: buttonText,
                  style: ButtonStyle.Primary,
                  customId: "open-ticket",
                },
              ],
            },
          ],
        });

        const producedMessage = yield* Effect.tryPromise(() =>
          interactionResponse.fetch(),
        );

        let roleId = pingableRole?.id;
        if (!roleId) {
          const { [SETTINGS.moderator]: mod } = yield* fetchSettingsEffect(
            interaction.guild.id,
            [SETTINGS.moderator, SETTINGS.modLog],
          );
          roleId = mod;
        }

        const db = yield* DatabaseService;
        yield* db.insertInto("tickets_config").values({
          message_id: producedMessage.id,
          channel_id: ticketChannel?.id,
          role_id: roleId,
        });

        featureStats.ticketChannelSetup(
          interaction.guild.id,
          interaction.user.id,
          ticketChannel?.id ?? interaction.channelId,
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect(
              "error",
              "TicketsSetup",
              "Error setting up tickets",
              { error },
            );
          }),
        ),
        Effect.withSpan("ticketsChannelCommand", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies SlashCommand,

  {
    command: { type: InteractionType.MessageComponent, name: "open-ticket" },
    handler: (interaction) =>
      Effect.gen(function* () {
        const modal = new ModalBuilder()
          .setCustomId("modal-open-ticket")
          .setTitle("What do you need from the moderators?");
        const actionRow = new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setLabel("Concern")
            .setCustomId("concern")
            .setMinLength(30)
            .setMaxLength(500)
            .setRequired(true)
            .setStyle(TextInputStyle.Paragraph),
        );
        // @ts-expect-error busted types
        modal.addComponents(actionRow);

        yield* Effect.tryPromise(() => interaction.showModal(modal));
      }).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.withSpan("openTicketModal", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies MessageComponentCommand,

  {
    command: { type: InteractionType.ModalSubmit, name: "modal-open-ticket" },
    handler: (interaction) =>
      Effect.gen(function* () {
        if (
          !interaction.channel ||
          interaction.channel.type !== ChannelType.GuildText ||
          !interaction.guild ||
          !interaction.message
        ) {
          yield* interactionReply(interaction, {
            content: "Something went wrong while creating a ticket",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const { channel, fields, user } = interaction;
        const concern = fields.getTextInputValue("concern");

        const db = yield* DatabaseService;
        const configRows = yield* db
          .selectFrom("tickets_config")
          .selectAll()
          .where("message_id", "=", interaction.message.id);
        let config = configRows[0];

        // If there's no config, that means that the button was set up before the db was set up. Add one with default values
        if (!config) {
          const { [SETTINGS.moderator]: mod } = yield* fetchSettingsEffect(
            interaction.guild.id,
            [SETTINGS.moderator, SETTINGS.modLog],
          );
          const insertedRows = yield* db
            .insertInto("tickets_config")
            .returningAll()
            .values({ message_id: interaction.message.id, role_id: mod });
          config = insertedRows[0];
          if (!config) {
            yield* Effect.fail(
              new Error("Something went wrong while fixing tickets config"),
            );
            return;
          }
        }

        // If channel_id is configured but fetch returns null (channel deleted),
        // this will error, which is intended - the configured channel is invalid
        const ticketsChannel = config.channel_id
          ? yield* fetchChannel(interaction.guild, config.channel_id)
          : channel;

        if (
          !ticketsChannel?.isTextBased() ||
          ticketsChannel.type !== ChannelType.GuildText
        ) {
          yield* interactionReply(
            interaction,
            "Couldn't make a ticket! Tell the admins that their ticket channel is misconfigured.",
          );
          return;
        }

        const thread = yield* Effect.tryPromise(() =>
          ticketsChannel.threads.create({
            name: `${user.username} – ${format(new Date(), "PP kk:mmX")}`,
            autoArchiveDuration: 60 * 24 * 7,
            type: ChannelType.PrivateThread,
            invitable: false,
          }),
        );

        yield* sendMessage(thread, {
          content: `<@${user.id}>, this is a private space only visible to you and the <@&${config.role_id}> role.`,
        });

        yield* sendMessage(
          thread,
          `${user.displayName} said:\n${quoteMessageContent(concern)}`,
        );

        yield* sendMessage(thread, {
          content: "When you've finished, please close the ticket.",
          components: [
            // @ts-expect-error Types for this are super busted
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`close-ticket||${user.id}|| `)
                .setLabel("Close ticket")
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId(`close-ticket||${user.id}||👍`)
                .setLabel("Close (👍)")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`close-ticket||${user.id}||👎`)
                .setLabel("Close (👎)")
                .setStyle(ButtonStyle.Danger),
            ),
          ],
        });

        featureStats.ticketCreated(interaction.guild.id, user.id, thread.id);

        yield* interactionReply(interaction, {
          content: `A private thread with the moderation team has been opened for you: <#${thread.id}>`,
          flags: [MessageFlags.Ephemeral],
        });
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect(
              "error",
              "TicketsModal",
              "Error creating ticket from modal",
              { error },
            );

            yield* interactionReply(interaction, {
              content: "Something went wrong while creating the ticket",
              flags: MessageFlags.Ephemeral,
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("modalOpenTicket", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies ModalCommand,

  {
    command: { type: InteractionType.MessageComponent, name: "close-ticket" },
    handler: (interaction) =>
      Effect.gen(function* () {
        const [, ticketOpenerUserId, feedback] =
          interaction.customId.split("||");
        const threadId = interaction.channelId;

        if (!interaction.member || !interaction.guild) {
          yield* logEffect(
            "error",
            "TicketsClose",
            "No member in ticket interaction",
            { interactionId: interaction.id },
          );
          yield* interactionReply(interaction, {
            content: "Something went wrong",
            flags: [MessageFlags.Ephemeral],
          });
          return;
        }

        const { [SETTINGS.modLog]: modLog } = yield* fetchSettingsEffect(
          interaction.guild.id,
          [SETTINGS.modLog],
        );

        const { user } = interaction.member;
        const interactionUserId = user.id;

        const db = yield* DatabaseService;
        const CLOSE_DELAY_MINUTES = 5;
        const scheduledFor = new Date(
          Date.now() + CLOSE_DELAY_MINUTES * 60 * 1000,
        ).toISOString();

        yield* Effect.all([
          // Schedule the opener removal in the DB so it survives restarts
          db.insertInto("pending_ticket_closures").values({
            id: crypto.randomUUID() as string,
            thread_id: threadId,
            opener_user_id: ticketOpenerUserId,
            closed_by_user_id: interactionUserId,
            guild_id: interaction.guild.id,
            scheduled_for: scheduledFor,
          }),
          Effect.tryPromise(() =>
            rest.post(Routes.channelMessages(modLog), {
              body: {
                content: `<@${ticketOpenerUserId}>'s ticket <#${threadId}> closed by <@${interactionUserId}>${feedback ? `. feedback: ${feedback}` : ""}`,
                allowedMentions: {},
              },
            }),
          ),
          interactionReply(interaction, {
            content: `The ticket was closed by <@${interactionUserId}>. <@${ticketOpenerUserId}> will be removed from this thread in ${CLOSE_DELAY_MINUTES} minutes.`,
            allowedMentions: {},
          }),
        ]);

        featureStats.ticketClosed(
          interaction.guild.id,
          interactionUserId,
          ticketOpenerUserId,
          !!feedback?.trim(),
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logEffect("error", "TicketsClose", "Error closing ticket", {
              error,
            });

            yield* interactionReply(interaction, {
              content: "Something went wrong while closing the ticket",
              flags: MessageFlags.Ephemeral,
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("closeTicket", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  } satisfies MessageComponentCommand,
];
