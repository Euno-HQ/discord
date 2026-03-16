import {
  AuditLogEvent,
  type AutoModerationRule,
  type GuildTextBasedChannel,
  type PartialUser,
  type User,
} from "discord.js";
import { Effect } from "effect";

import { AUDIT_LOG_WINDOW_MS, fetchAuditLogEntry } from "#~/discord/auditLog";
import { fetchChannelFromClient, sendMessage } from "#~/effects/discordSdk";
import { logEffect } from "#~/effects/observability";
import { truncateMessage } from "#~/helpers/string";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fetchRuleAuditLog = (
  rule: AutoModerationRule,
  event:
    | AuditLogEvent.AutoModerationRuleCreate
    | AuditLogEvent.AutoModerationRuleUpdate
    | AuditLogEvent.AutoModerationRuleDelete,
) =>
  fetchAuditLogEntry(rule.guild, rule.id, event, (entries) =>
    entries.find(
      (e) =>
        e.targetId === rule.id &&
        Date.now() - e.createdTimestamp < AUDIT_LOG_WINDOW_MS,
    ),
  );

const executorMention = (
  executor: User | PartialUser | null | undefined,
): string =>
  executor
    ? `by <@${executor.id}> (${executor.username})`
    : "by unknown moderator";

const timestampSuffix = () => `<t:${Math.floor(Date.now() / 1000)}:R>`;

// ─── Build diff summary for updates ─────────────────────────────────────────

const buildUpdateDiff = (
  oldRule: AutoModerationRule | null,
  newRule: AutoModerationRule,
): string => {
  if (!oldRule) return "configuration changed";

  const parts: string[] = [];

  // Name change
  if (oldRule.name !== newRule.name) {
    parts.push(`**${oldRule.name}** → **${newRule.name}**`);
  }

  // Enabled state
  if (oldRule.enabled !== newRule.enabled) {
    parts.push(
      `enabled: ${String(oldRule.enabled)} → ${String(newRule.enabled)}`,
    );
  }

  // Keyword filter count diff
  const oldKeywords = oldRule.triggerMetadata?.keywordFilter ?? [];
  const newKeywords = newRule.triggerMetadata?.keywordFilter ?? [];
  const keywordDelta = newKeywords.length - oldKeywords.length;
  if (keywordDelta !== 0) {
    const sign = keywordDelta > 0 ? "+" : "";
    const abs = Math.abs(keywordDelta);
    parts.push(`${sign}${keywordDelta} keyword${abs !== 1 ? "s" : ""}`);
  }

  // Regex pattern count diff
  const oldPatterns = oldRule.triggerMetadata?.regexPatterns ?? [];
  const newPatterns = newRule.triggerMetadata?.regexPatterns ?? [];
  const patternDelta = newPatterns.length - oldPatterns.length;
  if (patternDelta !== 0) {
    const sign = patternDelta > 0 ? "+" : "";
    const abs = Math.abs(patternDelta);
    parts.push(`${sign}${patternDelta} regex pattern${abs !== 1 ? "s" : ""}`);
  }

  // Exempt roles count diff
  const oldExemptRoles = oldRule.exemptRoles?.size ?? 0;
  const newExemptRoles = newRule.exemptRoles?.size ?? 0;
  const roleDelta = newExemptRoles - oldExemptRoles;
  if (roleDelta !== 0) {
    const sign = roleDelta > 0 ? "+" : "";
    const abs = Math.abs(roleDelta);
    parts.push(`${sign}${roleDelta} exempt role${abs !== 1 ? "s" : ""}`);
  }

  // Exempt channels count diff
  const oldExemptChannels = oldRule.exemptChannels?.size ?? 0;
  const newExemptChannels = newRule.exemptChannels?.size ?? 0;
  const channelDelta = newExemptChannels - oldExemptChannels;
  if (channelDelta !== 0) {
    const sign = channelDelta > 0 ? "+" : "";
    const abs = Math.abs(channelDelta);
    parts.push(`${sign}${channelDelta} exempt channel${abs !== 1 ? "s" : ""}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "minor configuration change";
};

// ─── Shared: fetch modLog channel ────────────────────────────────────────────

const fetchModLogChannel = (rule: AutoModerationRule) =>
  Effect.gen(function* () {
    const { modLog } = yield* fetchSettingsEffect(rule.guild.id, [
      SETTINGS.modLog,
    ]);
    if (!modLog) {
      yield* logEffect(
        "debug",
        "AutomodRuleLog",
        "mod-log channel not configured, skipping automod rule log",
        { guildId: rule.guild.id },
      );
      return yield* Effect.fail(new Error("modLog channel not configured"));
    }
    return yield* fetchChannelFromClient<GuildTextBasedChannel>(
      rule.guild.client,
      modLog,
    );
  });

// ─── Public handlers ─────────────────────────────────────────────────────────

export const logAutomodRuleCreate = (rule: AutoModerationRule) =>
  Effect.gen(function* () {
    yield* logEffect("info", "AutomodRuleLog", "Automod rule created", {
      ruleId: rule.id,
      ruleName: rule.name,
      guildId: rule.guild.id,
    });

    const entry = yield* fetchRuleAuditLog(
      rule,
      AuditLogEvent.AutoModerationRuleCreate,
    );
    const executor = entry?.executor ?? null;
    const channel = yield* fetchModLogChannel(rule);

    const content = truncateMessage(
      `-# Automod rule created\n**${rule.name}**\n-# ${executorMention(executor)} ${timestampSuffix()}`,
    );

    yield* sendMessage(channel, { content, allowedMentions: { parse: [] } });
  }).pipe(
    Effect.withSpan("logAutomodRuleCreate", {
      attributes: { ruleId: rule.id, guildId: rule.guild.id },
    }),
    Effect.catchAll((error) =>
      logEffect("error", "AutomodRuleLog", "Failed to log rule create", {
        error: String(error),
        ruleId: rule.id,
        guildId: rule.guild.id,
      }),
    ),
  );

export const logAutomodRuleDelete = (rule: AutoModerationRule) =>
  Effect.gen(function* () {
    yield* logEffect("info", "AutomodRuleLog", "Automod rule deleted", {
      ruleId: rule.id,
      ruleName: rule.name,
      guildId: rule.guild.id,
    });

    const entry = yield* fetchRuleAuditLog(
      rule,
      AuditLogEvent.AutoModerationRuleDelete,
    );
    const executor = entry?.executor ?? null;
    const channel = yield* fetchModLogChannel(rule);

    const content = truncateMessage(
      `-# Automod rule deleted\n~~**${rule.name}**~~\n-# ${executorMention(executor)} ${timestampSuffix()}`,
    );

    yield* sendMessage(channel, { content, allowedMentions: { parse: [] } });
  }).pipe(
    Effect.withSpan("logAutomodRuleDelete", {
      attributes: { ruleId: rule.id, guildId: rule.guild.id },
    }),
    Effect.catchAll((error) =>
      logEffect("error", "AutomodRuleLog", "Failed to log rule delete", {
        error: String(error),
        ruleId: rule.id,
        guildId: rule.guild.id,
      }),
    ),
  );

export const logAutomodRuleUpdate = (
  oldRule: AutoModerationRule | null,
  newRule: AutoModerationRule,
) =>
  Effect.gen(function* () {
    yield* logEffect("info", "AutomodRuleLog", "Automod rule updated", {
      ruleId: newRule.id,
      ruleName: newRule.name,
      guildId: newRule.guild.id,
    });

    const entry = yield* fetchRuleAuditLog(
      newRule,
      AuditLogEvent.AutoModerationRuleUpdate,
    );
    const executor = entry?.executor ?? null;
    const channel = yield* fetchModLogChannel(newRule);

    const diff = buildUpdateDiff(oldRule, newRule);

    const content = truncateMessage(
      `-# Automod rule updated\n**${newRule.name}**\n-# ${diff} · ${executorMention(executor)} ${timestampSuffix()}`,
    );

    yield* sendMessage(channel, { content, allowedMentions: { parse: [] } });
  }).pipe(
    Effect.withSpan("logAutomodRuleUpdate", {
      attributes: { ruleId: newRule.id, guildId: newRule.guild.id },
    }),
    Effect.catchAll((error) =>
      logEffect("error", "AutomodRuleLog", "Failed to log rule update", {
        error: String(error),
        ruleId: newRule.id,
        guildId: newRule.guild.id,
      }),
    ),
  );
