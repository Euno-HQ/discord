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

import { DiscordApiError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";

export const createChannel = (
  guild: Guild,
  options: GuildChannelCreateOptions,
) =>
  Effect.tryPromise({
    try: () => guild.channels.create(options),
    catch: (error) =>
      new DiscordApiError({ operation: "createChannel", cause: error }),
  }).pipe(
    Effect.withSpan("discord.createChannel", {
      attributes: { guildId: guild.id, channelName: options.name },
    }),
  );

export const fetchGuild = (client: Client, guildId: string) =>
  Effect.tryPromise({
    try: () => client.guilds.fetch(guildId),
    catch: (error) =>
      new DiscordApiError({ operation: "fetchGuild", cause: error }),
  }).pipe(Effect.withSpan("discord.fetchGuild", { attributes: { guildId } }));

export const fetchChannel = (guild: Guild, channelId: string) =>
  Effect.tryPromise({
    try: () => guild.channels.fetch(channelId),
    catch: (error) =>
      new DiscordApiError({ operation: "fetchChannel", cause: error }),
  }).pipe(
    Effect.withSpan("discord.fetchChannel", { attributes: { channelId } }),
  );

export const fetchChannelFromClient = <T = GuildTextBasedChannel>(
  client: Client,
  channelId: string,
) =>
  Effect.tryPromise({
    try: () => client.channels.fetch(channelId) as Promise<T>,
    catch: (error) =>
      new DiscordApiError({ operation: "fetchChannel", cause: error }),
  }).pipe(
    Effect.withSpan("discord.fetchChannel", {
      attributes: { channelId, variant: "fromClient" },
    }),
  );

export const fetchMember = (guild: Guild, userId: string) =>
  Effect.tryPromise({
    try: () => guild.members.fetch(userId),
    catch: (error) =>
      new DiscordApiError({ operation: "fetchMember", cause: error }),
  }).pipe(Effect.withSpan("discord.fetchMember", { attributes: { userId } }));

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
  Effect.tryPromise({
    try: () => client.users.fetch(userId),
    catch: (error) =>
      new DiscordApiError({ operation: "fetchUser", cause: error }),
  }).pipe(Effect.withSpan("discord.fetchUser", { attributes: { userId } }));

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
  Effect.tryPromise({
    try: () => channel.messages.fetch(messageId),
    catch: (error) =>
      new DiscordApiError({ operation: "fetchMessage", cause: error }),
  }).pipe(
    Effect.withSpan("discord.fetchMessage", {
      attributes: { messageId, channelId: channel.id },
    }),
  );

export const deleteMessage = (message: Message | PartialMessage) =>
  Effect.tryPromise({
    try: () => message.delete(),
    catch: (error) =>
      new DiscordApiError({ operation: "deleteMessage", cause: error }),
  }).pipe(
    Effect.withSpan("discord.deleteMessage", {
      attributes: { messageId: message.id },
    }),
  );

export const sendMessage = (
  channel: GuildTextBasedChannel | ThreadChannel,
  options: Parameters<typeof channel.send>[0],
) =>
  Effect.tryPromise({
    try: () => channel.send(options),
    catch: (error) =>
      new DiscordApiError({ operation: "sendMessage", cause: error }),
  }).pipe(
    Effect.withSpan("discord.sendMessage", {
      attributes: { channelId: channel.id },
    }),
  );

export const editMessage = (
  message: Message,
  options: Parameters<typeof message.edit>[0],
) =>
  Effect.tryPromise({
    try: () => message.edit(options),
    catch: (error) =>
      new DiscordApiError({ operation: "editMessage", cause: error }),
  }).pipe(
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
  Effect.tryPromise({
    try: () => message.reply(options),
    catch: (error) =>
      new DiscordApiError({ operation: "messageReply", cause: error }),
  }).pipe(
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
): Effect.Effect<Message, DiscordApiError, never> =>
  (msg.partial
    ? Effect.tryPromise({
        try: () => msg.fetch(),
        catch: (error) =>
          new DiscordApiError({
            operation: "resolveMessagePartial",
            cause: error,
          }),
      })
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
  Effect.tryPromise({
    try: () => interaction.reply(options),
    catch: (error) =>
      new DiscordApiError({ operation: "interactionReply", cause: error }),
  }).pipe(Effect.withSpan("discord.interactionReply"));

export const interactionDeferReply = (
  interaction:
    | MessageComponentInteraction
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction,
  options?: Parameters<typeof interaction.deferReply>[0],
) =>
  Effect.tryPromise({
    try: () => interaction.deferReply(options),
    catch: (error) =>
      new DiscordApiError({ operation: "interactionDeferReply", cause: error }),
  }).pipe(Effect.withSpan("discord.interactionDeferReply"));

export const interactionEditReply = (
  interaction:
    | MessageComponentInteraction
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction,
  options: Parameters<typeof interaction.editReply>[0],
) =>
  Effect.tryPromise({
    try: () => interaction.editReply(options),
    catch: (error) =>
      new DiscordApiError({ operation: "interactionEditReply", cause: error }),
  }).pipe(Effect.withSpan("discord.interactionEditReply"));

export const interactionFollowUp = (
  interaction:
    | MessageComponentInteraction
    | ChatInputCommandInteraction
    | UserContextMenuCommandInteraction
    | MessageContextMenuCommandInteraction,
  options: Parameters<typeof interaction.followUp>[0],
) =>
  Effect.tryPromise({
    try: () => interaction.followUp(options),
    catch: (error) =>
      new DiscordApiError({ operation: "interactionFollowUp", cause: error }),
  }).pipe(Effect.withSpan("discord.interactionFollowUp"));

export const interactionUpdate = (
  interaction: MessageComponentInteraction,
  options: Parameters<typeof interaction.update>[0],
) =>
  Effect.tryPromise({
    try: () => interaction.update(options),
    catch: (error) =>
      new DiscordApiError({ operation: "interactionUpdate", cause: error }),
  }).pipe(Effect.withSpan("discord.interactionUpdate"));

export const interactionDeferUpdate = (
  interaction: MessageComponentInteraction,
  options?: Parameters<typeof interaction.deferUpdate>[0],
) =>
  Effect.tryPromise({
    try: () => interaction.deferUpdate(options),
    catch: (error) =>
      new DiscordApiError({
        operation: "interactionDeferUpdate",
        cause: error,
      }),
  }).pipe(Effect.withSpan("discord.interactionDeferUpdate"));

/**
 * Softban a member: ban to delete their recent messages, then immediately
 * unban so they can rejoin a clean invite. Discord deletes messages
 * server-side based on `deleteMessageSeconds`.
 *
 * If `ban` succeeds but `unban` fails, the user is left BANNED. This case is
 * logged at error level inside the helper before the `DiscordApiError`
 * propagates, so the operational incident is never lost even if a caller
 * forgets to handle it. Callers can distinguish the failure mode by checking
 * `error.operation` — `softbanMember.ban` vs `softbanMember.unban`.
 */
export const softbanMember = (
  member: GuildMember,
  reason: string,
  deleteMessageSeconds: number,
): Effect.Effect<void, DiscordApiError, never> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => member.ban({ reason, deleteMessageSeconds }),
      catch: (error) =>
        new DiscordApiError({
          operation: "softbanMember.ban",
          cause: error,
        }),
    });

    yield* Effect.tryPromise({
      try: () => member.guild.members.unban(member, reason),
      catch: (error) =>
        new DiscordApiError({
          operation: "softbanMember.unban",
          cause: error,
        }),
    }).pipe(
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
