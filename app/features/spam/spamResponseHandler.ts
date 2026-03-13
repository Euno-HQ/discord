/**
 * Graduated response execution for spam verdicts.
 * Effect-based — performs Discord API calls and DB writes.
 */

import type { GuildMember, Message } from "discord.js";
import { Effect } from "effect";

import { logUserMessage } from "#~/commands/report/userLog.ts";
import { client } from "#~/discord/client.server.ts";
import { deleteMessage } from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import { featureStats } from "#~/helpers/metrics.ts";
import { applyRestriction, timeout } from "#~/models/discord.server.ts";
import {
  deleteAllReportedForUser,
  getSpamReportCount,
  getSpamReportGuildCount,
  markMessageAsDeleted,
  recordReport,
  ReportReasons,
} from "#~/models/reportedMessages.ts";

import { AUTO_KICK_THRESHOLD, type SpamVerdict } from "./spamScorer.ts";

/**
 * Number of guilds a user must be flagged in before triggering a cross-guild timeout.
 * This threshold indicates an account is likely compromised and being used to spam
 * across multiple communities simultaneously.
 */
const CROSS_GUILD_SPAM_THRESHOLD = 3;

/**
 * In-memory set tracking users who have already been sent a cross-guild DM this session.
 * Prevents repeatedly DMing the same user on every subsequent spam event.
 * Resets on bot restart, which is acceptable — the DM is informational, not critical.
 */
const crossGuildDmSent = new Set<string>();

/** Execute the graduated response for a spam verdict. */
export const executeResponse = (
  verdict: SpamVerdict,
  message: Message,
  member: GuildMember,
) =>
  Effect.gen(function* () {
    if (verdict.tier === "none") return;

    const guildId = message.guild!.id;
    const userId = message.author.id;

    yield* logEffect("info", "SpamResponse", `Spam verdict: ${verdict.tier}`, {
      tier: verdict.tier,
      score: verdict.totalScore,
      userId,
      guildId,
      summary: verdict.summary,
    });

    // Honeypot: softban (ban + unban to clear 7 days of messages)
    if (verdict.tier === "honeypot") {
      yield* executeSoftban(message, member, verdict);
      return;
    }

    // Low tier: log only, no delete
    if (verdict.tier === "low") {
      yield* logSpamReport(message, verdict);
      featureStats.spamFlaggedForReview(guildId, userId, message.channelId);
      return;
    }

    // Medium and high: delete the message first
    yield* deleteMessage(message).pipe(
      Effect.tap(() => markMessageAsDeleted(message.id, guildId)),
      Effect.catchTag("DiscordApiError", (e) =>
        logEffect("warn", "SpamResponse", "Failed to delete spam message", {
          error: String(e.cause),
        }),
      ),
    );

    if (verdict.tier === "medium") {
      // Apply restricted role
      yield* Effect.tryPromise(() => applyRestriction(member)).pipe(
        Effect.catchAll((error) =>
          logEffect("warn", "SpamResponse", "Failed to apply restriction", {
            error: String(error),
          }),
        ),
      );
      featureStats.spamRestricted(guildId, userId, message.channelId);
    }

    if (verdict.tier === "high") {
      // Timeout user in the originating guild
      yield* Effect.tryPromise(() =>
        timeout(member, "Automated spam detection"),
      ).pipe(
        Effect.catchAll((error) =>
          logEffect("warn", "SpamResponse", "Failed to timeout user", {
            error: String(error),
          }),
        ),
      );
      featureStats.spamTimedOut(guildId, userId, message.channelId);
    }

    // Log to mod thread for all medium/high tiers
    const logResult = yield* logSpamReport(message, verdict);

    // Check for auto-kick on high tier (spam reports only)
    if (verdict.tier === "high" && logResult) {
      const { message: logMessage } = logResult;
      const spamCount = yield* getSpamReportCount(userId, guildId);
      if (spamCount >= AUTO_KICK_THRESHOLD) {
        yield* Effect.tryPromise(() =>
          member.kick("Autokicked for repeated spam"),
        ).pipe(
          Effect.catchAll((error) =>
            logEffect("warn", "SpamResponse", "Failed to kick spammer", {
              error: String(error),
            }),
          ),
        );

        // Clean up all reported messages for the kicked user — including any
        // back-filled prior duplicates — so nothing is left behind on Discord.
        yield* deleteAllReportedForUser(userId, guildId).pipe(
          Effect.catchAll((error) =>
            logEffect(
              "warn",
              "SpamResponse",
              "Failed to delete reported messages after autokick",
              { error: String(error), userId, guildId },
            ),
          ),
        );

        yield* Effect.tryPromise(() =>
          logMessage.reply({
            content: `Automatically kicked <@${userId}> for spam`,
            allowedMentions: {},
          }),
        ).pipe(Effect.catchAll(() => Effect.void));

        featureStats.spamKicked(guildId, userId, spamCount);
      }

      // Check cross-guild spam threshold and timeout everywhere if met
      yield* checkCrossGuildSpam(userId);
    }

    featureStats.spamDetected(
      guildId,
      userId,
      message.channelId,
      verdict.tier,
      verdict.totalScore,
    );
  }).pipe(Effect.withSpan("SpamResponse.executeResponse"));

/**
 * Check if a user has been flagged for spam across enough guilds to trigger a
 * cross-guild response. When the threshold is met, times the user out in every
 * guild the bot is in and sends them a DM warning that their account may be
 * compromised.
 */
const checkCrossGuildSpam = (userId: string) =>
  Effect.gen(function* () {
    const guildCount = yield* getSpamReportGuildCount(userId);
    if (guildCount < CROSS_GUILD_SPAM_THRESHOLD) return;

    yield* logEffect(
      "warn",
      "SpamResponse",
      "Cross-guild spam threshold reached — timing out in all guilds",
      { userId, guildCount, threshold: CROSS_GUILD_SPAM_THRESHOLD },
    );

    const OVERNIGHT = 1000 * 60 * 60 * 20;
    const reason = `Cross-guild spam: flagged in ${guildCount} servers — account likely compromised`;

    // Timeout the user in every guild the bot is in (concurrently, limit 5)
    const guilds = [...client.guilds.cache.values()];
    yield* Effect.all(
      guilds.map((guild) =>
        Effect.tryPromise(async () => {
          const targetMember = await guild.members
            .fetch(userId)
            .catch(() => null);
          if (targetMember) {
            await targetMember.timeout(OVERNIGHT, reason);
          }
        }).pipe(
          Effect.catchAll((error) =>
            logEffect(
              "warn",
              "SpamResponse",
              "Failed to apply cross-guild timeout",
              { error: String(error), guildId: guild.id, userId },
            ),
          ),
        ),
      ),
      { concurrency: 5 },
    );

    // DM the user once per bot session to inform them their account may be compromised
    if (!crossGuildDmSent.has(userId)) {
      crossGuildDmSent.add(userId);
      yield* Effect.tryPromise(() =>
        client.users.send(
          userId,
          "⚠️ **Your account has been flagged for spam across multiple servers.**\n\n" +
            "This usually means your account has been compromised. Please:\n" +
            "• Change your Discord password immediately\n" +
            "• Enable two-factor authentication\n" +
            "• Revoke any suspicious authorized apps\n\n" +
            "Your account has been temporarily restricted while you secure it.",
        ),
      ).pipe(
        Effect.catchAll((error) =>
          logEffect(
            "warn",
            "SpamResponse",
            "Failed to send cross-guild DM to user",
            { error: String(error), userId },
          ),
        ),
      );
    }
  }).pipe(Effect.withSpan("SpamResponse.checkCrossGuildSpam"));

/** Log a spam report to the mod thread */
const logSpamReport = (message: Message, verdict: SpamVerdict) =>
  Effect.gen(function* () {
    const extra = `Score ${verdict.totalScore} (${verdict.tier}): ${verdict.summary}`;

    const result = yield* logUserMessage({
      reason: ReportReasons.spam,
      message,
      staff: client.user ?? false,
      extra,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* logEffect(
            "error",
            "SpamResponse",
            "Failed to log spam report",
            {
              error: String(error),
            },
          );
          return null;
        }),
      ),
    );

    // Back-fill any prior duplicate messages that were not logged when they
    // were first processed (because at that point they looked like tier=none).
    // We record them against the same mod-log thread post as the trigger message
    // so mods can see the full duplicate sequence, and so deleteAllReportedForUser
    // can clean them all up on kick.
    if (
      result &&
      verdict.priorDuplicates &&
      verdict.priorDuplicates.length > 0
    ) {
      const guildId = message.guild!.id;
      const userId = message.author.id;
      const logMessageId = result.message.id;
      const logChannelId = result.thread.id;
      const backfillExtra = `Back-filled prior duplicate. ${extra}`;

      for (const prior of verdict.priorDuplicates) {
        yield* recordReport({
          reportedMessageId: prior.messageId,
          reportedChannelId: prior.channelId,
          reportedUserId: userId,
          guildId,
          logMessageId,
          logChannelId,
          reason: ReportReasons.spam,
          extra: backfillExtra,
        }).pipe(
          Effect.catchAll((error) =>
            logEffect(
              "warn",
              "SpamResponse",
              "Failed to back-fill prior duplicate into reported_messages",
              { messageId: prior.messageId, error: String(error) },
            ),
          ),
        );
      }

      yield* logEffect(
        "info",
        "SpamResponse",
        `Back-filled ${verdict.priorDuplicates.length} prior duplicate(s)`,
        { userId, guildId },
      );
    }

    return result;
  }).pipe(Effect.withSpan("SpamResponse.logSpamReport"));

/** Execute a softban (ban + unban) for honeypot triggers */
const executeSoftban = (
  message: Message,
  member: GuildMember,
  verdict: SpamVerdict,
) =>
  Effect.gen(function* () {
    const guild = message.guild!;

    yield* Effect.tryPromise(async () => {
      await member.ban({
        reason: "honeypot spam detected",
        deleteMessageSeconds: 604800, // 7 days
      });
      await guild.members.unban(member);
    }).pipe(
      Effect.catchAll((error) =>
        logEffect("error", "SpamResponse", "Failed to softban user", {
          error: String(error),
          userId: member.id,
          guildId: guild.id,
        }),
      ),
    );

    yield* logSpamReport(message, verdict);

    featureStats.honeypotTriggered(guild.id, member.id, message.channelId);
  }).pipe(Effect.withSpan("SpamResponse.executeSoftban"));
