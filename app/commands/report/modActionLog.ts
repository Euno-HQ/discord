import { type Guild, type PartialUser, type User } from "discord.js";
import { Effect } from "effect";

import { forwardMessageSafe, sendMessage } from "#~/effects/discordSdk";
import { logEffect } from "#~/effects/observability";
import { truncateMessage } from "#~/helpers/string";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";
import { recordModAction } from "#~/models/modActions";
import { getOrCreateUserThread } from "#~/models/userThreads.ts";

export type ModActionReport =
  | {
      guild: Guild;
      user: User;
      actionType: "kick" | "ban" | "unban";
      executor: User | PartialUser | null;
      reason: string;
    }
  | {
      guild: Guild;
      user: User;
      actionType: "timeout";
      executor: User | PartialUser | null;
      reason: string;
      duration: string;
      isAutomod?: boolean;
    }
  | {
      guild: Guild;
      user: User;
      actionType: "timeout_removed";
      executor: User | PartialUser | null;
      reason: string;
    }
  | {
      guild: Guild;
      user: User;
      actionType: "left";
      executor: undefined;
      reason: undefined;
    };

export const logModAction = (report: ModActionReport) =>
  Effect.gen(function* () {
    const { guild, user, actionType, executor, reason } = report;
    yield* logEffect(
      "info",
      "logModAction",
      `${actionType} detected for ${user.username}`,
      {
        userId: user.id,
        guildId: guild.id,
        actionType,
        executorId: executor?.id,
        reason,
      },
    );

    if (actionType === "left") {
      return;
    }

    // Get or create persistent user thread
    const thread = yield* getOrCreateUserThread(guild, user);

    // Get mod log for forwarding
    const { modLog, moderator } = yield* fetchSettingsEffect(guild.id, [
      SETTINGS.modLog,
      SETTINGS.moderator,
    ]);

    // Construct the log message
    const logContent = formatModActionMessage(report);

    // Send log to thread
    const logMessage = yield* sendMessage(thread, {
      content: logContent,
      allowedMentions: { roles: [moderator] },
    });

    // Forward to mod log (non-critical)
    yield* forwardMessageSafe(logMessage, modLog);

    // Persist to database
    yield* recordModAction({
      userId: user.id,
      guildId: guild.id,
      actionType,
      executorId: executor?.id,
      executorUsername: executor?.username,
      reason,
      duration: actionType === "timeout" ? report.duration : undefined,
    });
  }).pipe(
    Effect.withSpan("logModAction", {
      attributes: {
        userId: report.user.id,
        guildId: report.guild.id,
        actionType: report.actionType,
      },
    }),
  );

/**
 * Pure function that formats the mod action log message content.
 * Extracted from logModAction for testability.
 */
export function formatModActionMessage(
  report: Exclude<ModActionReport, { actionType: "left" }>,
): string {
  const { user, actionType, executor, reason } = report;

  const actionLabels: Record<ModActionReport["actionType"], string> = {
    ban: "was banned",
    kick: "was kicked",
    unban: "was unbanned",
    timeout: "was timed out",
    timeout_removed: "had timeout removed",
    left: "left",
  };
  const actionLabel = actionLabels[actionType];
  const isAutomod = "isAutomod" in report && report.isAutomod === true;
  const executorMention = executor
    ? ` by <@${executor.id}> (${executor.username})`
    : isAutomod
      ? " by AutoMod"
      : " by unknown";

  const reasonText = reason ? ` ${reason}` : isAutomod ? "" : " for no reason";
  const durationText =
    actionType === "timeout" ? ` for ${report.duration}` : "";

  return truncateMessage(
    `<@${user.id}> (${user.username}) ${actionLabel}${durationText}
-# ${executorMention}${reasonText} <t:${Math.floor(Date.now() / 1000)}:R>`,
  ).trim();
}
