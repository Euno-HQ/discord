import { Events } from "discord.js";
import { Context, Effect, Layer, Queue, Stream } from "effect";

import { client } from "#~/discord/client.server";
import type { DiscordEvent } from "#~/discord/events";
import { log } from "#~/helpers/observability";

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
      if (message.author.bot || message.author.system || !message.inGuild())
        return;
      if (!message.member) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMemberMessage",
          message,
          guild: message.guild,
          member: message.member,
        }),
      );
    });

    client.on(Events.MessageDelete, (message) => {
      if (message.system || message.author?.bot || !message.guildId) return;
      const guild = client.guilds.cache.get(message.guildId);
      if (!guild) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMessageDelete",
          message,
          guild,
          guildId: message.guildId,
        }),
      );
    });

    client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
      if (
        !newMessage.guildId ||
        newMessage.author?.bot ||
        newMessage.author?.system
      )
        return;
      if (oldMessage.content === newMessage.content) return;
      const guild = client.guilds.cache.get(newMessage.guildId);
      if (!guild) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMessageUpdate",
          oldMessage,
          newMessage,
          guild,
          guildId: newMessage.guildId,
        }),
      );
    });

    client.on(Events.MessageBulkDelete, (messages, channel) => {
      const guildId = messages.first()?.guildId ?? channel.guildId;
      if (!guildId) return;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      Effect.runFork(
        Queue.offer(queue, {
          type: "GuildMessageBulkDelete",
          messages,
          channel,
          guild,
          guildId,
        }),
      );
    });

    // TODO: Add remaining event types as handlers are migrated to pipelines.
    // For now, only message events are queued (deletion logger is first consumer).

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
