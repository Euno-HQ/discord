/**
 * Discord SDK - Effect-TS wrappers for common Discord.js operations.
 *
 * These helpers provide consistent error handling and reduce boilerplate
 * when calling Discord.js APIs from Effect-based code.
 *
 * All wrappers include `Effect.withSpan("discord.<operation>")` for
 * performance tracing. Span names use a `discord.` prefix consistently.
 */
import type {
  AutoModerationRule,
  ChatInputCommandInteraction,
  Client,
  Guild,
  GuildChannelCreateOptions,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  MessageComponentInteraction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  PartialMessage,
  ThreadChannel,
  User,
  UserContextMenuCommandInteraction,
} from "discord.js";
import { Effect } from "effect";

import { tryDiscord } from "#~/effects/classifyDiscordError";
import type { DiscordError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";

export const createChannel = (
  guild: Guild,
  options: GuildChannelCreateOptions,
) =>
  tryDiscord("createChannel", () => guild.channels.create(options)).pipe(
    Effect.withSpan("discord.createChannel", {
      attributes: { guildId: guild.id, channelName: options.name },
    }),
  );

export const fetchGuild = (client: Client, guildId: string) =>
  tryDiscord("fetchGuild", () => client.guilds.fetch(guildId)).pipe(
    Effect.withSpan("discord.fetchGuild", { attributes: { guildId } }),
  );

export const fetchChannel = (guild: Guild, channelId: string) =>
  tryDiscord("fetchChannel", () => guild.channels.fetch(channelId)).pipe(
    Effect.withSpan("discord.fetchChannel", { attributes: { channelId } }),
  );

export const fetchChannelFromClient = <T = GuildTextBasedChannel>(
  client: Client,
  channelId: string,
) =>
  tryDiscord(
    "fetchChannel",
    () => client.channels.fetch(channelId) as Promise<T>,
  ).pipe(
    Effect.withSpan("discord.fetchChannel", {
      attributes: { channelId, variant: "fromClient" },
    }),
  );

/**
 * Resolve an automod rule by id, returning `null` instead of failing when the
 * rule can't be fetched (e.g. it was deleted, or the bot lacks permission).
 *
 * The `AutoModerationActionExecution` event payload only reliably carries
 * `ruleId`; its `autoModerationRule` getter reads from a cache that is usually
 * empty at action time, so callers that need the rule name must fetch it.
 */
export const fetchAutomodRuleOrNull = (
  guild: Guild,
  ruleId: string,
): Effect.Effect<AutoModerationRule | null, never, never> =>
  Effect.tryPromise({
    try: () => guild.autoModerationRules.fetch(ruleId),
    catch: () => null,
  }).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({ found: result !== null }),
    ),
    Effect.withSpan("discord.fetchAutomodRule", {
      attributes: { guildId: guild.id, ruleId, variant: "orNull" },
    }),
  );

export const fetchMember = (guild: Guild, userId: string) =>
  tryDiscord("fetchMember", () => guild.members.fetch(userId)).pipe(
    Effect.withSpan("discord.fetchMember", { attributes: { userId } }),
  );

export const fetchMemberOrNull = (
  guild: Guild,
  userId: string,
): Effect.Effect<GuildMember | null, never, never> =>
  Effect.tryPromise({
    try: () => guild.members.fetch(userId),
    catch: () => null,
  }).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({ found: result !== null }),
    ),
    Effect.withSpan("discord.fetchMember", {
      attributes: { userId, variant: "orNull" },
    }),
  );

export const fetchUser = (client: Client, userId: string) =>
  tryDiscord("fetchUser", () => client.users.fetch(userId)).pipe(
    Effect.withSpan("discord.fetchUser", { attributes: { userId } }),
  );

export const fetchUserOrNull = (
  client: Client,
  userId: string,
): Effect.Effect<User | null, never, never> =>
  Effect.tryPromise({
    try: () => client.users.fetch(userId),
    catch: () => null,
  }).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({ found: result !== null }),
    ),
    Effect.withSpan("discord.fetchUser", {
      attributes: { userId, variant: "orNull" },
    }),
  );

export const fetchMessage = (
  channel: GuildTextBasedChannel | ThreadChannel,
  messageId: string,
) =>
  tryDiscord("fetchMessage", () => channel.messages.fetch(messageId)).pipe(
    Effect.withSpan("discord.fetchMessage", {
      attributes: { messageId, channelId: channel.id },
    }),
  );

export const deleteMessage = (message: Message | PartialMessage) =>
  tryDiscord("deleteMessage", () => message.delete()).pipe(
    Effect.withSpan("discord.deleteMessage", {
      attributes: { messageId: message.id },
    }),
  );

export const sendMessage = (
  channel: GuildTextBasedChannel | ThreadChannel,
  options: Parameters<typeof channel.send>[0],
) =>
  tryDiscord("sendMessage", () => channel.send(options)).pipe(
    Effect.withSpan("discord.sendMessage", {
      attributes: { channelId: channel.id },
    }),
  );

export const editMessage = (
  message: Message,
  options: Parameters<typeof message.edit>[0],
) =>
  tryDiscord("editMessage", () => message.edit(options)).pipe(
    Effect.withSpan("discord.editMessage", {
      attributes: { messageId: message.id },
    }),
  );

export const forwardMessageSafe = (message: Message, targetChannelId: string) =>
  Effect.tryPromise({
    try: () => message.forward(targetChannelId),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      logEffect("error", "Discord SDK", "failed to forward to modLog", {
        error,
        messageId: message.id,
        targetChannelId,
      }),
    ),
    Effect.withSpan("discord.forwardMessage", {
      attributes: { messageId: message.id, targetChannelId, variant: "safe" },
    }),
  );

export const messageReply = (
  message: Message,
  options: Parameters<Message["reply"]>[0],
) =>
  tryDiscord("messageReply", () => message.reply(options)).pipe(
    Effect.withSpan("discord.messageReply", {
      attributes: { messageId: message.id },
    }),
  );

export const replyAndForwardSafe = (
  message: Message,
  content: string,
  forwardToChannelId: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const reply = await message.reply({ content });
      await reply.forward(forwardToChannelId);
      return reply;
    },
    catch: () => null,
  }).pipe(
    Effect.catchAll((error) =>
      logEffect("warn", "Discord SDK", "Could not reply and forward message", {
        error,
        messageId: message.id,
        forwardToChannelId,
      }),
    ),
    Effect.withSpan("discord.replyAndForward", {
      attributes: {
        messageId: message.id,
        forwardToChannelId,
        variant: "safe",
      },
    }),
  );

/**
 * Resolve a potentially partial message to a full Message.
 * Only fetches from Discord API if the message is partial.
 * Provides type narrowing from Message | PartialMessage to Message.
 */
export const resolveMessagePartial = (
  msg: Message | PartialMessage,
): Effect.Effect<Message, DiscordError, never> =>
  (msg.partial
    ? tryDiscord("resolveMessagePartial", () => msg.fetch())
    : Effect.succeed(msg)
  ).pipe(
    Effect.withSpan("discord.resolveMessagePartial", {
      attributes: { wasPartial: msg.partial },
    }),
  );

export const interactionReply = (
  interaction:
    | MessageComponentInteraction
    | ModalSubmitInteraction
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction,
  options: Parameters<typeof interaction.reply>[0],
) =>
  tryDiscord("interactionReply", () => interaction.reply(options)).pipe(
    Effect.withSpan("discord.interactionReply"),
  );

export const interactionDeferReply = (
  interaction:
    | MessageComponentInteraction
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction,
  options?: Parameters<typeof interaction.deferReply>[0],
) =>
  tryDiscord("interactionDeferReply", () =>
    interaction.deferReply(options),
  ).pipe(Effect.withSpan("discord.interactionDeferReply"));

export const interactionEditReply = (
  interaction:
    | MessageComponentInteraction
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction,
  options: Parameters<typeof interaction.editReply>[0],
) =>
  tryDiscord("interactionEditReply", () => interaction.editReply(options)).pipe(
    Effect.withSpan("discord.interactionEditReply"),
  );

export const interactionFollowUp = (
  interaction:
    | MessageComponentInteraction
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction,
  options: Parameters<typeof interaction.followUp>[0],
) =>
  tryDiscord("interactionFollowUp", () => interaction.followUp(options)).pipe(
    Effect.withSpan("discord.interactionFollowUp"),
  );

export const interactionUpdate = (
  interaction: MessageComponentInteraction,
  options: Parameters<typeof interaction.update>[0],
) =>
  tryDiscord("interactionUpdate", () => interaction.update(options)).pipe(
    Effect.withSpan("discord.interactionUpdate"),
  );

export const interactionDeferUpdate = (
  interaction: MessageComponentInteraction,
  options?: Parameters<typeof interaction.deferUpdate>[0],
) =>
  tryDiscord("interactionDeferUpdate", () =>
    interaction.deferUpdate(options),
  ).pipe(Effect.withSpan("discord.interactionDeferUpdate"));

/**
 * Softban a member: ban to delete their recent messages, then immediately
 * unban so they can rejoin a clean invite. Discord deletes messages
 * server-side based on `deleteMessageSeconds`.
 *
 * If `ban` succeeds but `unban` fails, the user is left BANNED. This case is
 * logged at error level inside the helper before the `DiscordError`
 * propagates, so the operational incident is never lost even if a caller
 * forgets to handle it. Callers can distinguish the failure mode by checking
 * `error.operation` — `softbanMember.ban` vs `softbanMember.unban`.
 */
export const softbanMember = (
  member: GuildMember,
  reason: string,
  deleteMessageSeconds: number,
): Effect.Effect<void, DiscordError, never> =>
  Effect.gen(function* () {
    yield* tryDiscord("softbanMember.ban", () =>
      member.ban({ reason, deleteMessageSeconds }),
    );

    yield* tryDiscord("softbanMember.unban", () =>
      member.guild.members.unban(member, reason),
    ).pipe(
      Effect.tapError((error) =>
        logEffect(
          "error",
          "Discord",
          "Softban: ban succeeded but unban failed — user is BANNED",
          {
            error,
            userId: member.id,
            guildId: member.guild.id,
          },
        ),
      ),
    );
  }).pipe(
    Effect.withSpan("discord.softbanMember", {
      attributes: {
        userId: member.id,
        guildId: member.guild.id,
        deleteMessageSeconds,
      },
    }),
  );
