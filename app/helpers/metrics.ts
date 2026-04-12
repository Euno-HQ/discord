import type {
  ChatInputCommandInteraction,
  Guild,
  Message,
  MessageComponentInteraction,
  MessageContextMenuCommandInteraction,
  ThreadChannel,
  UserContextMenuCommandInteraction,
} from "discord.js";

import type { PostHog } from "posthog-node";

import { runtime } from "#~/AppRuntime";
import { PostHogService } from "#~/effects/posthog";
import { log } from "#~/helpers/observability";

let _posthog: PostHog | null | undefined;

/** Must be called once at startup before event handlers fire. */
export async function initPostHogMetrics(): Promise<void> {
  _posthog = await runtime.runPromise(PostHogService);
}

type EventValue = string | number | boolean;
type EmitEventData = Record<string, EventValue | EventValue[]>;

const events = {
  // Existing events
  messageTracked: "message sent",
  botStarted: "bot started",
  guildJoined: "bot installed",
  guildRemoved: "bot uninstalled",
  threadCreated: "thread created",
  gatewayError: "gateway error",
  reconnection: "bot reconnected",
  commandExecuted: "command executed",
  commandFailed: "command failed",
  setupCompleted: "setup completed",
  reportSubmitted: "report submitted",
  // New events from Issue #227
  userTracked: "user tracked",
  ticketChannelSetup: "ticket channel setup",
  ticketCreated: "ticket created",
  ticketClosed: "ticket closed",
  honeypotSetup: "honeypot setup",
  honeypotTriggered: "honeypot triggered",
  reactjiChannelSetup: "reactji channel setup",
  reactjiTriggered: "reactji triggered",
  spamDetected: "spam detected",
  spamFlaggedForReview: "spam flagged for review",
  spamRestricted: "spam restricted",
  spamTimedOut: "spam timed out",
  spamKicked: "spam kicked",
};

export const threadStats = {
  messageTracked: (message: Message) =>
    emitEvent(events.messageTracked, {
      data: { guildId: message.guild?.id ?? "none" },
      guildId: message.guild?.id,
    }),
};

export const botStats = {
  botStarted: (guildCount: number, userCount: number) =>
    emitEvent(events.botStarted, {
      data: { guildCount, userCount },
    }),

  guildJoined: (guild: Guild) =>
    emitEvent(events.guildJoined, {
      data: {
        guildId: guild.id,
        guildName: guild.name,
        memberCount: guild.memberCount,
      },
      guildId: guild.id,
    }),

  guildRemoved: (guild: Guild) =>
    emitEvent(events.guildRemoved, {
      data: {
        guildId: guild.id,
        guildName: guild.name,
        memberCount: guild.memberCount,
      },
      guildId: guild.id,
    }),

  threadCreated: (thread: ThreadChannel) =>
    emitEvent(events.threadCreated, {
      data: {
        threadId: thread.id,
        guildId: thread.guild.id,
        channelId: thread.parentId ?? "none",
        threadName: thread.name,
      },
      guildId: thread.guild.id,
    }),

  gatewayError: (error: string, guildCount: number) =>
    emitEvent(events.gatewayError, {
      data: { error, guildCount },
    }),

  reconnection: (guildCount: number, userCount: number) =>
    emitEvent(events.reconnection, {
      data: { guildCount, userCount },
    }),
};

export const commandStats = {
  commandExecuted: (
    interaction:
      | ChatInputCommandInteraction
      | MessageContextMenuCommandInteraction
      | UserContextMenuCommandInteraction,
    commandName: string,
    success = true,
    duration?: number,
  ) =>
    emitEvent(events.commandExecuted, {
      data: {
        commandName,
        success,
        guildId: interaction.guildId ?? "none",
        userId: interaction.user.id,
        channelId: interaction.channelId,
        duration: duration ?? 0,
      },
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
    }),

  commandFailed: (
    interaction:
      | ChatInputCommandInteraction
      | MessageContextMenuCommandInteraction
      | UserContextMenuCommandInteraction,
    commandName: string,
    error: string,
    duration?: number,
  ) =>
    emitEvent(events.commandFailed, {
      data: {
        commandName,
        error,
        guildId: interaction.guildId ?? "none",
        userId: interaction.user.id,
        channelId: interaction.channelId,
        duration: duration ?? 0,
      },
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
    }),

  setupCompleted: (
    interaction: ChatInputCommandInteraction | MessageComponentInteraction,
    settings: Record<string, string | undefined>,
  ) =>
    emitEvent(events.setupCompleted, {
      data: {
        guildId: interaction.guildId ?? "none",
        userId: interaction.user.id,
        settingsCount: Object.keys(settings).length,
        hasModRole: !!settings.moderator,
        hasModChannel: !!settings.modLog,
        hasRestrictedRole: !!settings.restricted,
      },
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
    }),

  reportSubmitted: (
    interaction: MessageContextMenuCommandInteraction,
    targetUserId: string,
  ) =>
    emitEvent(events.reportSubmitted, {
      data: {
        guildId: interaction.guildId ?? "none",
        reporterUserId: interaction.user.id,
        targetUserId,
        channelId: interaction.channelId,
      },
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
    }),
};

export const featureStats = {
  userTracked: (guildId: string, userId: string, targetUserId: string) =>
    emitEvent(events.userTracked, {
      data: { guildId, targetUserId },
      userId,
      guildId,
    }),

  ticketChannelSetup: (guildId: string, userId: string, channelId: string) =>
    emitEvent(events.ticketChannelSetup, {
      data: { guildId, channelId },
      userId,
      guildId,
    }),

  ticketCreated: (guildId: string, userId: string, threadId: string) =>
    emitEvent(events.ticketCreated, {
      data: { guildId, threadId },
      userId,
      guildId,
    }),

  ticketClosed: (
    guildId: string,
    closedByUserId: string,
    ticketOpenerId: string,
    hasFeedback: boolean,
  ) =>
    emitEvent(events.ticketClosed, {
      data: { guildId, ticketOpenerId, hasFeedback },
      userId: closedByUserId,
      guildId,
    }),

  honeypotSetup: (guildId: string, userId: string, channelId: string) =>
    emitEvent(events.honeypotSetup, {
      data: { guildId, channelId },
      userId,
      guildId,
    }),

  honeypotTriggered: (
    guildId: string,
    spammerUserId: string,
    channelId: string,
  ) =>
    emitEvent(events.honeypotTriggered, {
      data: { guildId, channelId, spammerUserId },
      userId: spammerUserId,
      guildId,
    }),

  reactjiChannelSetup: (
    guildId: string,
    userId: string,
    emoji: string,
    threshold: number,
  ) =>
    emitEvent(events.reactjiChannelSetup, {
      data: { guildId, emoji, threshold },
      userId,
      guildId,
    }),

  reactjiTriggered: (
    guildId: string,
    triggeredByUserId: string,
    emoji: string,
    messageId: string,
  ) =>
    emitEvent(events.reactjiTriggered, {
      data: { guildId, emoji, messageId },
      userId: triggeredByUserId,
      guildId,
    }),

  spamDetected: (
    guildId: string,
    spammerUserId: string,
    channelId: string,
    tier?: string,
    score?: number,
  ) =>
    emitEvent(events.spamDetected, {
      data: {
        guildId,
        channelId,
        spammerUserId,
        tier: tier ?? "unknown",
        score: score ?? 0,
      },
      userId: spammerUserId,
      guildId,
    }),

  spamFlaggedForReview: (
    guildId: string,
    spammerUserId: string,
    channelId: string,
  ) =>
    emitEvent(events.spamFlaggedForReview, {
      data: { guildId, channelId, spammerUserId },
      userId: spammerUserId,
      guildId,
    }),

  spamRestricted: (guildId: string, spammerUserId: string, channelId: string) =>
    emitEvent(events.spamRestricted, {
      data: { guildId, channelId, spammerUserId },
      userId: spammerUserId,
      guildId,
    }),

  spamTimedOut: (guildId: string, spammerUserId: string, channelId: string) =>
    emitEvent(events.spamTimedOut, {
      data: { guildId, channelId, spammerUserId },
      userId: spammerUserId,
      guildId,
    }),

  spamKicked: (guildId: string, kickedUserId: string, warningCount: number) =>
    emitEvent(events.spamKicked, {
      data: { guildId, kickedUserId, warningCount },
      guildId,
    }),
};

const emitEvent = (
  eventName: string,
  {
    data,
    userId,
    guildId,
  }: { data?: EmitEventData; userId?: string; guildId?: string } = {},
) => {
  log("info", "Metrics", "event emitted", {
    user_id: userId,
    event_type: eventName,
    event_properties: data,
    client: Boolean(_posthog),
  });

  _posthog?.capture({
    distinctId: userId ?? "system",
    event: eventName,
    properties: {
      ...data,
      $groups: guildId ? { guild: guildId } : undefined,
    },
  });
};
