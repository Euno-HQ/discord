import {
  Events,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type PartialMessage,
  type ReadonlyCollection,
} from "discord.js";
import { Context, Effect, Layer, Queue, Stream } from "effect";

import { DiscordClient, listenScoped } from "#~/discord/client.server";
import type {
  DiscordEvent,
  GuildMemberMessage,
  GuildMessageBulkDelete,
  GuildMessageDelete,
  GuildMessageUpdate,
} from "#~/discord/events";
import { logEffect } from "#~/effects/observability.ts";
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

// --- Queue routing ---

/**
 * Which queue each event type rides. Moderation-critical events get their own
 * queue so a stalled high-volume subscriber can't evict them: today a backed-up
 * `MessageCreate` consumer fills the shared sliding queue with messages and a
 * ban that arrives meanwhile is the oldest thing dropped soon after.
 *
 * - critical: low volume, and losing one loses a mod-log entry or onboarding —
 *   bans/unbans, audit-log entries (kicks, timeouts), automod actions and
 *   rule changes, message deletes (single + bulk), guild join/leave.
 * - bulk: high volume, best-effort — message create/update, reactions.
 *
 * A Record (not a Set) so adding a DiscordEvent variant is a compile error
 * until it is routed here.
 */
export const EVENT_QUEUE: Record<DiscordEvent["type"], "critical" | "bulk"> = {
  GuildBanAdd: "critical",
  GuildBanRemove: "critical",
  GuildAuditLogEntryCreate: "critical",
  AutoModerationActionExecution: "critical",
  AutoModerationRuleCreate: "critical",
  AutoModerationRuleDelete: "critical",
  AutoModerationRuleUpdate: "critical",
  GuildMessageDelete: "critical",
  GuildMessageBulkDelete: "critical",
  GuildCreate: "critical",
  GuildDelete: "critical",
  GuildMemberMessage: "bulk",
  GuildMessageUpdate: "bulk",
  MessageReactionAdd: "bulk",
  MessageReactionRemove: "bulk",
};

export const QUEUE_CAPACITY = 1024;
const DROP_WARN_INTERVAL_MS = 30_000;

/**
 * Wrap a sliding queue's synchronous offer with drop accounting. A sliding
 * queue never rejects — when full it evicts the oldest element — so a drop is
 * "the queue was full at offer time". Drops are counted and surfaced as at most
 * one warn per `intervalMs`, carrying the count since the previous warn.
 *
 * ponytail: drops after the last warn in a burst are only reported by the next
 * drop; add a periodic flush (or a Metric counter) when a metrics exporter lands.
 */
export const countingOffer = <A>(
  queue: Queue.Queue<A>,
  name: string,
  {
    intervalMs = DROP_WARN_INTERVAL_MS,
    now = Date.now,
    warn = (context: Record<string, unknown>) =>
      log(
        "warn",
        "DiscordEventBus",
        "Event queue full: dropped oldest events",
        context,
      ),
  }: {
    intervalMs?: number;
    now?: () => number;
    warn?: (context: Record<string, unknown>) => void;
  } = {},
) => {
  let dropped = 0;
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  return (item: A) => {
    if (Queue.isFullUnsafe(queue)) {
      dropped++;
      const t = now();
      if (t - lastWarnAt >= intervalMs) {
        warn({ queue: name, dropped, capacity: QUEUE_CAPACITY });
        dropped = 0;
        lastWarnAt = t;
      }
    }
    Queue.offerUnsafe(queue, item);
  };
};

// --- Service definition ---

export interface IDiscordEventBus {
  /** Every event (critical + bulk merged). */
  readonly stream: Stream.Stream<DiscordEvent>;
  /** Moderation-critical events only — see EVENT_QUEUE. */
  readonly critical: Stream.Stream<DiscordEvent>;
  /** High-volume events only — see EVENT_QUEUE. */
  readonly bulk: Stream.Stream<DiscordEvent>;
}

export class DiscordEventBus extends Context.Service<
  DiscordEventBus,
  IDiscordEventBus
>()("DiscordEventBus") {}

export const DiscordEventBusLive = Layer.effect(
  DiscordEventBus,
  Effect.gen(function* () {
    const client = yield* DiscordClient;
    const criticalQueue = yield* Queue.sliding<DiscordEvent>(QUEUE_CAPACITY);
    const bulkQueue = yield* Queue.sliding<DiscordEvent>(QUEUE_CAPACITY);
    const offerCritical = countingOffer(criticalQueue, "critical");
    const offerBulk = countingOffer(bulkQueue, "bulk");
    const offer = (event: DiscordEvent) =>
      EVENT_QUEUE[event.type] === "critical"
        ? offerCritical(event)
        : offerBulk(event);

    // --- Register event sources ---
    // Scoped to the Layer: each listener is removed when the runtime is
    // disposed. Callbacks push synchronously (sliding queues never block).

    yield* listenScoped(client, Events.MessageCreate, (message) => {
      const event = enrichMessageCreate(message);
      if (event) {
        offer(event);
        return;
      }
      // Diagnostic: a human, in-guild message whose member didn't resolve is
      // dropped here and never reaches any pipeline. This is the one non-obvious
      // drop reason — surface it so it isn't silent.
      if (
        !message.author.bot &&
        !message.author.system &&
        message.inGuild() &&
        !message.member
      ) {
        log(
          "debug",
          "DiscordEventBus",
          "MessageCreate dropped: member unresolved",
          {
            messageId: message.id,
            authorId: message.author.id,
            channelId: message.channelId,
            guildId: message.guildId,
          },
        );
      }
    });

    yield* listenScoped(client, Events.MessageDelete, (message) => {
      const event = enrichMessageDelete(message, client.guilds.cache);
      if (event) offer(event);
    });

    yield* listenScoped(
      client,
      Events.MessageUpdate,
      (oldMessage, newMessage) => {
        const event = enrichMessageUpdate(
          oldMessage,
          newMessage,
          client.guilds.cache,
        );
        if (event) offer(event);
      },
    );

    yield* listenScoped(
      client,
      Events.MessageBulkDelete,
      (messages, channel) => {
        const event = enrichMessageBulkDelete(
          messages,
          channel,
          client.guilds.cache,
        );
        if (event) offer(event);
      },
    );

    yield* listenScoped(client, Events.MessageReactionAdd, (reaction, user) => {
      offer({ type: "MessageReactionAdd", reaction, user });
    });

    yield* listenScoped(
      client,
      Events.MessageReactionRemove,
      (reaction, user) => {
        offer({ type: "MessageReactionRemove", reaction, user });
      },
    );

    yield* listenScoped(client, Events.GuildBanAdd, (ban) => {
      offer({ type: "GuildBanAdd", ban });
    });

    yield* listenScoped(client, Events.GuildBanRemove, (ban) => {
      offer({ type: "GuildBanRemove", ban });
    });

    yield* listenScoped(
      client,
      Events.GuildAuditLogEntryCreate,
      (entry, guild) => {
        offer({ type: "GuildAuditLogEntryCreate", entry, guild });
      },
    );

    yield* listenScoped(
      client,
      Events.AutoModerationActionExecution,
      (execution) => {
        offer({ type: "AutoModerationActionExecution", execution });
      },
    );

    yield* listenScoped(client, Events.AutoModerationRuleCreate, (rule) => {
      offer({ type: "AutoModerationRuleCreate", rule });
    });

    yield* listenScoped(client, Events.AutoModerationRuleDelete, (rule) => {
      offer({ type: "AutoModerationRuleDelete", rule });
    });

    yield* listenScoped(
      client,
      Events.AutoModerationRuleUpdate,
      (oldRule, newRule) => {
        offer({ type: "AutoModerationRuleUpdate", oldRule, newRule });
      },
    );

    yield* listenScoped(client, Events.GuildCreate, (guild) => {
      offer({ type: "GuildCreate", guild });
    });

    yield* listenScoped(client, Events.GuildDelete, (guild) => {
      offer({ type: "GuildDelete", guild });
    });

    yield* logEffect("info", "DiscordEventBus", "Event source registered");

    // One broadcast per queue — each subscriber gets independent backpressure.
    // A subscriber of only `bulk` (automod, reactji) can stall without ever
    // holding back the critical queue. The Layer's Scope keeps both alive for
    // the runtime lifetime.
    const critical = yield* Stream.broadcast(Stream.fromQueue(criticalQueue), {
      capacity: QUEUE_CAPACITY,
    });
    const bulk = yield* Stream.broadcast(Stream.fromQueue(bulkQueue), {
      capacity: QUEUE_CAPACITY,
    });

    return { critical, bulk, stream: Stream.merge(critical, bulk) };
  }),
);
