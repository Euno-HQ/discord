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
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";

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

/**
 * Element-level diff for two string lists. Returns the items present in `next`
 * but not `prev` (added) and the items present in `prev` but not `next`
 * (removed). Order-insensitive; duplicates collapse via Set semantics.
 */
const diffStringLists = (
  prev: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } => {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((item) => !prevSet.has(item)),
    removed: prev.filter((item) => !nextSet.has(item)),
  };
};

/** Truncate a long list of changed items so the log line stays readable. */
const summarizeItems = (items: string[], max = 5): string => {
  const shown = items.slice(0, max).map((item) => `\`${item}\``);
  const overflow = items.length - shown.length;
  return overflow > 0
    ? `${shown.join(", ")} +${overflow} more`
    : shown.join(", ");
};

const formatListChange = (
  label: string,
  { added, removed }: { added: string[]; removed: string[] },
): string | null => {
  if (added.length === 0 && removed.length === 0) return null;
  const segments: string[] = [];
  if (added.length > 0) segments.push(`+${summarizeItems(added)}`);
  if (removed.length > 0) segments.push(`−${summarizeItems(removed)}`);
  return `${label}: ${segments.join(" ")}`;
};

const countDelta = (
  label: string,
  oldCount: number,
  newCount: number,
): string | null => {
  const delta = newCount - oldCount;
  if (delta === 0) return null;
  const sign = delta > 0 ? "+" : "";
  const abs = Math.abs(delta);
  return `${sign}${delta} ${label}${abs !== 1 ? "s" : ""}`;
};

export const buildUpdateDiff = (
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

  // Keyword filter element-level diff (surface the actual added/removed words)
  const keywordChange = formatListChange(
    "keywords",
    diffStringLists(
      oldRule.triggerMetadata?.keywordFilter ?? [],
      newRule.triggerMetadata?.keywordFilter ?? [],
    ),
  );
  if (keywordChange) parts.push(keywordChange);

  // Regex pattern element-level diff
  const regexChange = formatListChange(
    "regex",
    diffStringLists(
      oldRule.triggerMetadata?.regexPatterns ?? [],
      newRule.triggerMetadata?.regexPatterns ?? [],
    ),
  );
  if (regexChange) parts.push(regexChange);

  // Allow-list element-level diff
  const allowChange = formatListChange(
    "allow-list",
    diffStringLists(
      oldRule.triggerMetadata?.allowList ?? [],
      newRule.triggerMetadata?.allowList ?? [],
    ),
  );
  if (allowChange) parts.push(allowChange);

  // Action / response types (e.g. block message, timeout, send alert)
  const actionChange = formatListChange(
    "actions",
    diffStringLists(
      (oldRule.actions ?? []).map((a) => String(a.type)),
      (newRule.actions ?? []).map((a) => String(a.type)),
    ),
  );
  if (actionChange) parts.push(actionChange);

  // Exempt roles count diff
  const roleChange = countDelta(
    "exempt role",
    oldRule.exemptRoles?.size ?? 0,
    newRule.exemptRoles?.size ?? 0,
  );
  if (roleChange) parts.push(roleChange);

  // Exempt channels count diff
  const channelChange = countDelta(
    "exempt channel",
    oldRule.exemptChannels?.size ?? 0,
    newRule.exemptChannels?.size ?? 0,
  );
  if (channelChange) parts.push(channelChange);

  return parts.length > 0 ? parts.join(" · ") : "minor configuration change";
};

// ─── Shared: fetch modLog channel ────────────────────────────────────────────

const fetchModLogChannel = (rule: AutoModerationRule) =>
  Effect.gen(function* () {
    const { modLog } = yield* fetchSettings(rule.guild.id, [SETTINGS.modLog]);
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
        error,
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
        error,
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
        error,
        ruleId: newRule.id,
        guildId: newRule.guild.id,
      }),
    ),
  );
