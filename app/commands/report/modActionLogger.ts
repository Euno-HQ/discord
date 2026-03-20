import { formatDistanceToNowStrict } from "date-fns";
import {
  AuditLogEvent,
  type AutoModerationActionExecution,
  type Guild,
  type GuildBan,
  type GuildMember,
  type PartialGuildMember,
  type User,
} from "discord.js";
import { Effect } from "effect";

import { logAutomod } from "#~/commands/report/automodLog.ts";
import { AUDIT_LOG_WINDOW_MS, fetchAuditLogEntry } from "#~/discord/auditLog";
import { fetchUser } from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";

import { logModAction } from "./modActionLog";

export const banAddEffect = (ban: GuildBan) =>
  Effect.gen(function* () {
    const { guild, user } = ban;
    let { reason } = ban;

    yield* logEffect("info", "ModActionLogger", "Ban detected", {
      userId: user.id,
      guildId: guild.id,
      reason,
    });

    const entry = yield* fetchAuditLogEntry(
      guild,
      user.id,
      AuditLogEvent.MemberBanAdd,
      (entries) =>
        entries.find(
          (e) =>
            e.targetId === user.id &&
            Date.now() - e.createdTimestamp < AUDIT_LOG_WINDOW_MS,
        ),
    );

    const executor = entry?.executor ?? null;
    reason = entry?.reason ?? reason;

    // Skip if the bot performed this action (it's already logged elsewhere)
    if (executor?.id === guild.client.user?.id) {
      yield* logEffect("debug", "ModActionLogger", "Skipping self-ban", {
        userId: user.id,
        guildId: guild.id,
      });
      return;
    }

    yield* logModAction({
      guild,
      user,
      actionType: "ban",
      executor,
      reason: reason ?? "",
    });
  }).pipe(Effect.withSpan("handleBanAdd"));

export const banRemoveEffect = (ban: GuildBan) =>
  Effect.gen(function* () {
    const { guild, user } = ban;

    yield* logEffect("info", "ModActionLogger", "Unban detected", {
      userId: user.id,
      guildId: guild.id,
    });

    const entry = yield* fetchAuditLogEntry(
      guild,
      user.id,
      AuditLogEvent.MemberBanRemove,
      (entries) =>
        entries.find(
          (e) =>
            e.targetId === user.id &&
            Date.now() - e.createdTimestamp < AUDIT_LOG_WINDOW_MS,
        ),
    );

    const executor = entry?.executor ?? null;
    const reason = entry?.reason ?? "";

    // Skip if the bot performed this action (it's already logged elsewhere)
    if (executor?.id === guild.client.user?.id) {
      yield* logEffect("debug", "ModActionLogger", "Skipping self-unban", {
        userId: user.id,
        guildId: guild.id,
      });
      return;
    }

    yield* logModAction({
      guild,
      user,
      actionType: "unban",
      executor,
      reason,
    });
  }).pipe(Effect.withSpan("handleBanRemove"));

const fetchKickAuditLog = (guild: Guild, user: User) =>
  Effect.gen(function* () {
    const entry = yield* fetchAuditLogEntry(
      guild,
      user.id,
      AuditLogEvent.MemberKick,
      (entries) =>
        entries.find(
          (e) =>
            e.targetId === user.id &&
            Date.now() - e.createdTimestamp < AUDIT_LOG_WINDOW_MS,
        ),
    );

    // If no kick entry found after retries, user left voluntarily
    if (!entry) {
      yield* logEffect(
        "debug",
        "ModActionLogger",
        "No kick entry found after retries, user left voluntarily",
        { userId: user.id, guildId: guild.id },
      );
      return {
        actionType: "left" as const,
        user,
        guild,
        executor: undefined,
        reason: undefined,
      };
    }

    const { executor, reason } = entry;

    if (!executor) {
      yield* logEffect(
        "warn",
        "ModActionLogger",
        `No executor found for audit log entry`,
        { userId: user.id, guildId: guild.id },
      );
    }

    // Skip if the bot performed this action
    if (executor?.id === guild.client.user?.id) {
      yield* logEffect("debug", "ModActionLogger", "Skipping self-kick", {
        userId: user.id,
        guildId: guild.id,
      });
      return undefined;
    }

    return {
      actionType: "kick" as const,
      user,
      guild,
      executor,
      reason: reason ?? "",
    };
  });

export const memberRemoveEffect = (member: GuildMember | PartialGuildMember) =>
  Effect.gen(function* () {
    const { guild, user } = member;

    yield* logEffect("info", "ModActionLogger", "Member removal detected", {
      userId: user.id,
      guildId: guild.id,
    });

    const auditLogs = yield* fetchKickAuditLog(guild, user);
    if (!auditLogs || auditLogs.actionType === "left") {
      return;
    }

    const { executor = null, reason = "" } = auditLogs;
    yield* logModAction({
      guild,
      user,
      actionType: "kick",
      executor,
      reason,
    });
  }).pipe(Effect.withSpan("handleMemberRemove"));

export const automodActionEffect = (execution: AutoModerationActionExecution) =>
  Effect.gen(function* () {
    const {
      guild,
      userId,
      channelId,
      messageId,
      content,
      action,
      matchedContent,
      matchedKeyword,
      autoModerationRule,
    } = execution;

    yield* logEffect("info", "Automod", "Automod action executed", {
      userId,
      guildId: guild.id,
      channelId,
      messageId,
      actionType: action.type,
      ruleName: autoModerationRule?.name,
      matchedKeyword,
    });

    const user = yield* fetchUser(guild.client, userId);

    yield* logAutomod({
      guild,
      user,
      content: content ?? matchedContent ?? "[Content not available]",
      channelId: channelId ?? undefined,
      messageId: messageId ?? undefined,
      ruleName: autoModerationRule?.name ?? "Unknown rule",
      matchedKeyword: matchedKeyword ?? matchedContent ?? undefined,
      actionType: action.type,
    });
  }).pipe(Effect.withSpan("handleAutomodAction"));

export const memberUpdateEffect = (
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember | PartialGuildMember,
) =>
  Effect.gen(function* () {
    const { guild, user } = newMember;
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;

    // Determine if this is a timeout applied or removed
    const isTimeoutApplied = newTimeout !== null && newTimeout > Date.now();
    const isTimeoutRemoved =
      oldTimeout !== null && oldTimeout > Date.now() && newTimeout === null;

    // No timeout change relevant to us
    if (!isTimeoutApplied && !isTimeoutRemoved) {
      return;
    }

    // Capture duration immediately before audit log lookup
    const duration = isTimeoutApplied
      ? formatDistanceToNowStrict(new Date(newTimeout))
      : undefined;

    yield* logEffect(
      "info",
      "ModActionLogger",
      isTimeoutApplied ? "Timeout detected" : "Timeout removal detected",
      {
        userId: user.id,
        guildId: guild.id,
        duration,
      },
    );

    const entry = yield* fetchAuditLogEntry(
      guild,
      user.id,
      AuditLogEvent.MemberUpdate,
      (entries) =>
        entries.find((e) => {
          if (e.targetId !== user.id) return false;
          if (Date.now() - e.createdTimestamp >= AUDIT_LOG_WINDOW_MS)
            return false;
          const timeoutChange = e.changes?.find(
            (change) => change.key === "communication_disabled_until",
          );
          return timeoutChange !== undefined;
        }),
    );

    const executor = entry?.executor ?? null;
    const reason = entry?.reason ?? "";

    // Skip if the bot performed this action (it's already logged elsewhere)
    if (executor?.id === guild.client.user?.id) {
      yield* logEffect("debug", "ModActionLogger", "Skipping self-timeout", {
        userId: user.id,
        guildId: guild.id,
      });
      return;
    }

    if (isTimeoutApplied) {
      yield* logModAction({
        guild,
        user,
        actionType: "timeout",
        executor,
        reason,
        duration: duration!,
      });
    } else {
      yield* logModAction({
        guild,
        user,
        actionType: "timeout_removed",
        executor,
        reason,
      });
    }
  }).pipe(Effect.withSpan("handleMemberUpdate"));
