import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
  type APIEmbed,
  type APIEmbedField,
} from "discord.js";
import { Effect } from "effect";

import { ReadableReasons } from "#~/commands/report/constructLog";
import {
  interactionDeferReply,
  interactionEditReply,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import type { SlashCommand } from "#~/helpers/discord";
import { formatError } from "#~/helpers/formatError";
import { commandStats } from "#~/helpers/metrics";
import { truncateMessage } from "#~/helpers/string";
import { getDeletionLogThread } from "#~/models/deletionLogThreads";
import {
  getModActionCounts,
  getRecentModActions,
  type ModActionType,
} from "#~/models/modActions";
import {
  getChannelBreakdown,
  getMonthlyReportCounts,
  getRecentReportCount,
  getStaffBreakdown,
  getUserReportSummary,
  type ReportReasons,
} from "#~/models/reportedMessages";
import { getUserThread } from "#~/models/userThreads";

const parseDate = (value: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const SPARKLINE_BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * Build a sparkline string from monthly report counts.
 * Fills in zero for months with no data so the shape is continuous.
 */
const buildSparkline = (
  monthlyData: { month: unknown; count: unknown }[],
  numMonths: number,
): string | null => {
  if (monthlyData.length === 0) return null;

  // Build a map of YYYY-MM -> count
  const countsByMonth = new Map<string, number>();
  for (const row of monthlyData) {
    countsByMonth.set(String(row.month), Number(row.count));
  }

  // Generate the last N months as YYYY-MM keys
  const now = new Date();
  const months: string[] = [];
  for (let i = numMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
  }

  const values = months.map((m) => countsByMonth.get(m) ?? 0);
  const max = Math.max(...values);
  if (max === 0) return null;

  const spark = values
    .map((v) => {
      const idx = Math.round((v / max) * (SPARKLINE_BLOCKS.length - 1));
      return SPARKLINE_BLOCKS[idx];
    })
    .join("");

  return spark;
};

const actionLabels: Record<ModActionType, string> = {
  kick: "Kicked",
  ban: "Banned",
  unban: "Unbanned",
  timeout: "Timed out",
  timeout_removed: "Timeout removed",
};

export const Command = {
  command: new SlashCommandBuilder()
    .setName("modreport")
    .setDescription("Show a summary of a user's moderation history")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addUserOption((x) =>
      x.setName("user").setDescription("The user to look up").setRequired(true),
    ) as SlashCommandBuilder,

  handler: (interaction) =>
    Effect.gen(function* () {
      yield* interactionDeferReply(interaction);

      const targetUser = interaction.options.getUser("user", true);
      const guildId = interaction.guildId;

      if (!guildId) {
        yield* interactionEditReply(interaction, {
          content: "This command can only be used in a server.",
        });
        return;
      }

      yield* logEffect("info", "Commands", "Modreport command executed", {
        guildId,
        userId: interaction.user.id,
        targetUserId: targetUser.id,
      });

      const SPARKLINE_MONTHS = 6;
      const [
        summary,
        userThread,
        deletionThread,
        actionCounts,
        recentActions,
        recency,
        channels,
        staff,
        monthlyData,
      ] = yield* Effect.all([
        getUserReportSummary(targetUser.id, guildId),
        getUserThread(targetUser.id, guildId),
        getDeletionLogThread(targetUser.id, guildId),
        getModActionCounts(targetUser.id, guildId),
        getRecentModActions(targetUser.id, guildId),
        getRecentReportCount(targetUser.id, guildId),
        getChannelBreakdown(targetUser.id, guildId),
        getStaffBreakdown(targetUser.id, guildId),
        getMonthlyReportCounts(targetUser.id, guildId, SPARKLINE_MONTHS),
      ]);

      const hasActions = Object.keys(actionCounts).length > 0;

      if (summary.reportCount === 0 && !hasActions) {
        yield* interactionEditReply(interaction, {
          content: `No moderation history found for <@${targetUser.id}>.`,
          allowedMentions: { users: [] },
        });
        commandStats.commandExecuted(interaction, "modreport", true);
        return;
      }

      // --- Description: top-line summary ---
      const descLines: string[] = [];

      if (summary.reportCount > 0) {
        // Recency line
        if (recency.recent > 0 && recency.total > recency.recent) {
          descLines.push(
            `${recency.recent} report${recency.recent === 1 ? "" : "s"} in the last ${recency.days} days (${recency.total} total)`,
          );
        } else {
          descLines.push(
            `${summary.uniqueMessages} message${summary.uniqueMessages === 1 ? "" : "s"} reported ${summary.reportCount} time${summary.reportCount === 1 ? "" : "s"} across ${summary.uniqueChannels} channel${summary.uniqueChannels === 1 ? "" : "s"}`,
          );
        }

        const firstDate = parseDate(summary.firstReport);
        const lastDate = parseDate(summary.lastReport);
        if (firstDate && lastDate) {
          const peakPart =
            summary.peakDayCount > 1
              ? `. Most reports in a single day was ${summary.peakDayCount}`
              : "";
          if (summary.reportCount === 1) {
            descLines.push(`Reported ${time(firstDate, "R")}${peakPart}`);
          } else {
            descLines.push(
              `First reported ${time(firstDate, "D")}; most recently ${time(lastDate, "R")}${peakPart}`,
            );
          }
        }

        const sparkline = buildSparkline(monthlyData, SPARKLINE_MONTHS);
        if (sparkline) {
          descLines.push(`\`${sparkline}\` (last ${SPARKLINE_MONTHS} months)`);
        }
      }

      // Action count summary line
      const actionSummaryLabels: [ModActionType, string][] = [
        ["kick", "Kicked"],
        ["ban", "Banned"],
        ["timeout", "Timed out"],
      ];
      const actionParts = actionSummaryLabels
        .filter(([type]) => actionCounts[type])
        .map(
          ([type, label]) =>
            `${label} ${actionCounts[type]} time${actionCounts[type] === 1 ? "" : "s"}`,
        );
      if (actionParts.length > 0) {
        descLines.push(actionParts.join(" · "));
      }

      // Thread links
      const threadLinks = [
        userThread
          ? `[Moderation logs](https://discord.com/channels/${guildId}/${userThread.thread_id})`
          : null,
        deletionThread
          ? `[Deleted message logs](https://discord.com/channels/${guildId}/${deletionThread.thread_id})`
          : null,
      ].filter(Boolean);
      if (threadLinks.length > 0) {
        descLines.push(threadLinks.join(" · "));
      }

      // --- Embed fields ---
      const fields: APIEmbedField[] = [];

      // Reason breakdown
      if (summary.reasonBreakdown.length > 0) {
        const reasonText = summary.reasonBreakdown
          .map(
            (r) =>
              `${ReadableReasons[r.reason as ReportReasons] ?? r.reason} ×${r.count}`,
          )
          .join("\n");
        fields.push({
          name: "Reasons",
          value: truncateMessage(reasonText, 1024),
          inline: true,
        });
      }

      // Channel breakdown
      if (channels.length > 0) {
        const channelText = channels
          .map((c) => `<#${c.reported_channel_id}> (${Number(c.count)})`)
          .join("\n");
        fields.push({
          name: "Top Channels",
          value: truncateMessage(channelText, 1024),
          inline: true,
        });
      }

      // Staff reporter breakdown
      if (staff.length > 0) {
        const staffText = staff
          .map((s) => `@${s.staff_username} (${Number(s.count)})`)
          .join("\n");
        fields.push({
          name: "Reported By",
          value: truncateMessage(staffText, 1024),
          inline: true,
        });
      }

      // Mod action timeline
      if (recentActions.length > 0) {
        const timelineLines = recentActions.map((a) => {
          const actionLabel =
            actionLabels[a.action_type as ModActionType] ?? a.action_type;
          const executor = a.executor_username
            ? ` by @${a.executor_username}`
            : "";
          const reason = a.reason ? ` — "${a.reason}"` : "";
          const timestamp = parseDate(a.created_at);
          const ts = timestamp ? ` ${time(timestamp, "R")}` : "";
          return `${actionLabel}${executor}${reason}${ts}`;
        });
        fields.push({
          name: "Actions",
          value: truncateMessage(timelineLines.join("\n"), 1024),
          inline: false,
        });
      }

      const embed: APIEmbed = {
        author: {
          name: targetUser.username,
          icon_url: targetUser.displayAvatarURL(),
        },
        description: descLines.join("\n"),
        fields: fields.length > 0 ? fields : undefined,
      };

      yield* interactionEditReply(interaction, {
        embeds: [embed],
      });

      commandStats.commandExecuted(interaction, "modreport", true);
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* logEffect("error", "Commands", "Modreport command failed", {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            error,
          });

          commandStats.commandFailed(
            interaction,
            "modreport",
            formatError(error),
          );

          yield* interactionEditReply(interaction, {
            content: "Failed to fetch moderation summary.",
          }).pipe(Effect.catchAll(() => Effect.void));
        }),
      ),
      Effect.withSpan("modreportCommand", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
    ),
} satisfies SlashCommand;
