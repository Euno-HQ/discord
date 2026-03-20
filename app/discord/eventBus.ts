import {
  Events,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type PartialMessage,
  type ReadonlyCollection,
} from "discord.js";
import { Context, Effect, Layer, Queue, Stream } from "effect";

import { client } from "#~/discord/client.server";
import type {
  DiscordEvent,
  GuildMemberMessage,
  GuildMessageBulkDelete,
  GuildMessageDelete,
  GuildMessageUpdate,
} from "#~/discord/events";
import { log } from "#~/helpers/observability";

// --- Pure enrichment functions ---
// Extracted from event callbacks so they can be tested without mocking the
// Discord client. Each returns null when the event should be filtered out.

/** Enrich a MessageCreate event. Returns null if the message should be filtered out. */
export const enrichMessageCreate = (
  message: Message,
): GuildMemberMessage | null => {
  if (message.author.bot || message.author.system || !message.inGuild())
    return null;
  if (!message.member) return null;
  return {
    type: "GuildMemberMessage",
    message,
    guild: message.guild,
    member: message.member,
  };
};

/** Enrich a MessageDelete event. Returns null if the message should be filtered out. */
export const enrichMessageDelete = (
  message: Message | PartialMessage,
  guildCache: { get(id: string): Guild | undefined },
): GuildMessageDelete | null => {
  if (message.system || message.author?.bot || !message.guildId) return null;
  const guild = guildCache.get(message.guildId);
  if (!guild) return null;
  return {
    type: "GuildMessageDelete",
    message,
    guild,
    guildId: message.guildId,
  };
};

/** Enrich a MessageUpdate event. Returns null if the message should be filtered out. */
export const enrichMessageUpdate = (
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
  guildCache: { get(id: string): Guild | undefined },
): GuildMessageUpdate | null => {
  if (
    !newMessage.guildId ||
    newMessage.author?.bot ||
    newMessage.author?.system
  )
    return null;
  if (oldMessage.content === newMessage.content) return null;
  const guild = guildCache.get(newMessage.guildId);
  if (!guild) return null;
  return {
    type: "GuildMessageUpdate",
    oldMessage,
    newMessage,
    guild,
    guildId: newMessage.guildId,
  };
};

/** Enrich a MessageBulkDelete event. Returns null if the event should be filtered out. */
export const enrichMessageBulkDelete = (
  messages: ReadonlyCollection<string, Message | PartialMessage>,
  channel: GuildTextBasedChannel,
  guildCache: { get(id: string): Guild | undefined },
): GuildMessageBulkDelete | null => {
  const guildId = messages.first()?.guildId ?? channel.guildId;
  if (!guildId) return null;
  const guild = guildCache.get(guildId);
  if (!guild) return null;
  return { type: "GuildMessageBulkDelete", messages, channel, guild, guildId };
};

// --- Service definition ---

export interface IDiscordEventBus {
  readonly stream: Stream.Stream<DiscordEvent>;
}

export class DiscordEventBus extends Context.Tag("DiscordEventBus")<
  DiscordEventBus,
  IDiscordEventBus
>() {}

export const DiscordEventBusLive = Layer.scoped(
  DiscordEventBus,
  Effect.gen(function* () {
    const queue = yield* Queue.sliding<DiscordEvent>(1024);

    // --- Register event sources ---
    // These run once at Layer construction. The callbacks close over the queue
    // and push events with Effect.runFork (fire-and-forget, non-blocking).

    client.on(Events.MessageCreate, (message) => {
      const event = enrichMessageCreate(message);
      if (event) Effect.runFork(Queue.offer(queue, event));
    });

    client.on(Events.MessageDelete, (message) => {
      const event = enrichMessageDelete(message, client.guilds.cache);
      if (event) Effect.runFork(Queue.offer(queue, event));
    });

    client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
      const event = enrichMessageUpdate(
        oldMessage,
        newMessage,
        client.guilds.cache,
      );
      if (event) Effect.runFork(Queue.offer(queue, event));
    });

    client.on(Events.MessageBulkDelete, (messages, channel) => {
      const event = enrichMessageBulkDelete(
        messages,
        channel,
        client.guilds.cache,
      );
      if (event) Effect.runFork(Queue.offer(queue, event));
    });

    client.on(Events.MessageReactionAdd, (reaction, user) => {
      Effect.runFork(
        Queue.offer(queue, { type: "MessageReactionAdd", reaction, user }),
      );
    });

    client.on(Events.MessageReactionRemove, (reaction, user) => {
      Effect.runFork(
        Queue.offer(queue, { type: "MessageReactionRemove", reaction, user }),
      );
    });

    client.on(Events.GuildBanAdd, (ban) => {
      Effect.runFork(Queue.offer(queue, { type: "GuildBanAdd", ban }));
    });

    client.on(Events.GuildBanRemove, (ban) => {
      Effect.runFork(Queue.offer(queue, { type: "GuildBanRemove", ban }));
    });

    client.on(Events.GuildMemberRemove, (member) => {
      Effect.runFork(Queue.offer(queue, { type: "GuildMemberRemove", member }));
    });

    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      Effect.runFork(
        Queue.offer(queue, { type: "GuildMemberUpdate", oldMember, newMember }),
      );
    });

    client.on(Events.AutoModerationActionExecution, (execution) => {
      Effect.runFork(
        Queue.offer(queue, {
          type: "AutoModerationActionExecution",
          execution,
        }),
      );
    });

    client.on(Events.GuildCreate, (guild) => {
      Effect.runFork(Queue.offer(queue, { type: "GuildCreate", guild }));
    });

    client.on(Events.GuildDelete, (guild) => {
      Effect.runFork(Queue.offer(queue, { type: "GuildDelete", guild }));
    });

    log("info", "DiscordEventBus", "Event source registered");

    // Create broadcast stream — each subscriber gets independent backpressure.
    // The Scope from Layer.scoped keeps the broadcast alive for the runtime lifetime.
    const stream = yield* Stream.broadcastDynamic(
      Stream.fromQueue(queue),
      1024,
    );

    return { stream };
  }),
);
