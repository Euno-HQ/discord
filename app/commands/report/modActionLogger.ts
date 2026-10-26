import { formatDistanceStrict } from "date-fns";
import {
  AuditLogEvent,
  type AutoModerationActionExecution,
  type AutoModerationRule,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildBan,
} from "discord.js";
import { Effect } from "effect";

import { logAutomod } from "#~/commands/report/automodLog.ts";
import {
  AUDIT_LOG_WINDOW_MS,
  fetchAuditLogEntryOrNull,
} from "#~/discord/auditLog";
import {
  fetchAutomodRuleOrNull,
  fetchUser,
  fetchUserOrNull,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";

import { logModAction } from "./modActionLog";

/**
 * Resolve the display name for an automod rule, preferring a freshly fetched
 * rule, then the (often-empty) cached rule on the execution payload, then a
 * stable fallback. Pure so it can be unit-tested without a Discord client.
 */
export const resolveRuleName = (
  fetchedRule: AutoModerationRule | null,
  cachedRule: AutoModerationRule | null,
): string => fetchedRule?.name ?? cachedRule?.name ?? "Unknown rule";

export const banAddEffect = (ban: GuildBan) =>
  Effect.gen(function* () {
    const { guild, user } = ban;
    let { reason } = ban;

    yield* logEffect("info", "ModActionLogger", "Ban detected", {
      userId: user.id,
      guildId: guild.id,
      reason,
    });

    const entry = yield* fetchAuditLogEntryOrNull(
      "ModActionLogger",
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

    const entry = yield* fetchAuditLogEntryOrNull(
      "ModActionLogger",
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

export const automodActionEffect = (execution: AutoModerationActionExecution) =>
  Effect.gen(function* () {
    const {
      guild,
      userId,
      channelId,
      messageId,
      content,
      action,
      ruleId,
      matchedContent,
      matchedKeyword,
      autoModerationRule,
    } = execution;

    // The execution payload's `autoModerationRule` getter reads from a cache
    // that is usually empty at action time, so fetch the rule by id to get a
    // reliable name (falling back to the cached rule, then a stable default).
    const fetchedRule = yield* fetchAutomodRuleOrNull(guild, ruleId);
    const ruleName = resolveRuleName(fetchedRule, autoModerationRule);

    yield* logEffect("info", "Automod", "Automod action executed", {
      userId,
      guildId: guild.id,
      channelId,
      messageId,
      actionType: action.type,
      ruleId,
      ruleName,
      matchedKeyword,
    });

    const user = yield* fetchUser(guild.client, userId);

    yield* logAutomod({
      guild,
      user,
      content: content ?? matchedContent ?? "[Content not available]",
      channelId: channelId ?? undefined,
      messageId: messageId ?? undefined,
      ruleName,
      matchedKeyword: matchedKeyword ?? matchedContent ?? undefined,
      actionType: action.type,
    });
  }).pipe(Effect.withSpan("handleAutomodAction"));

/**
 * Kick / timeout logging via GuildAuditLogEntryCreate. Replaces the
 * GuildMemberRemove/GuildMemberUpdate handlers, which need the privileged
 * GuildMembers intent (revoked 2026-09). The executor and reason come
 * straight from the entry, so no audit-log polling is needed.
 */
export const auditLogEntryEffect = (entry: GuildAuditLogsEntry, guild: Guild) =>
  Effect.gen(function* () {
    const { action, targetId, executorId } = entry;
    const isAutomod =
      action === AuditLogEvent.AutoModerationUserCommunicationDisabled;
    const isKick = action === AuditLogEvent.MemberKick;
    const timeoutChange =
      action === AuditLogEvent.MemberUpdate || isAutomod
        ? entry.changes.find((c) => c.key === "communication_disabled_until")
        : undefined;

    if (!targetId || (!isKick && !isAutomod && !timeoutChange)) return;

    const botId = guild.client.user?.id;
    // For automod, the executor is the rule creator (misleading), so use null
    const executor = isAutomod
      ? null
      : (entry.executor ??
        (executorId ? yield* fetchUserOrNull(guild.client, executorId) : null));
    const reason = entry.reason ?? "";

    // Skip if the bot performed this action (it's already logged elsewhere)
    if (!isAutomod && executorId && executorId === botId) {
      yield* logEffect("debug", "ModActionLogger", "Skipping self-action", {
        targetId,
        guildId: guild.id,
        action,
      });
      return;
    }

    const user = yield* fetchUser(guild.client, targetId);

    if (isKick) {
      yield* logEffect("info", "ModActionLogger", "Kick detected", {
        userId: user.id,
        guildId: guild.id,
      });
      yield* logModAction({
        guild,
        user,
        actionType: "kick",
        executor,
        reason,
      });
      return;
    }

    // Timeout applied (new value is a future ISO timestamp) or removed.
    // Automod entries may carry no change; they are always an application.
    const newValue: unknown = timeoutChange?.new;
    const until =
      typeof newValue === "string" ? new Date(newValue).getTime() : null;
    const isApplied = isAutomod || (until !== null && until > Date.now());
    const isRemoved = !isApplied && until === null;
    if (!isApplied && !isRemoved) return;

    yield* logEffect(
      "info",
      "ModActionLogger",
      isApplied ? "Timeout detected" : "Timeout removal detected",
      { userId: user.id, guildId: guild.id },
    );

    if (isApplied) {
      yield* logModAction({
        guild,
        user,
        actionType: "timeout",
        executor,
        reason,
        duration:
          until !== null
            ? formatDistanceStrict(new Date(until), entry.createdTimestamp)
            : "unknown duration",
        isAutomod,
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
  }).pipe(Effect.withSpan("handleAuditLogEntry"));
