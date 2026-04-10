import type { Message, User } from "discord.js";
import { Effect } from "effect";
import type { Selectable } from "kysely";

import { DatabaseService } from "#~/Database";
import type { DB } from "#~/db";
import { client } from "#~/discord/client.server";
import { logEffect } from "#~/effects/observability";

export type ReportedMessage = Selectable<DB["reported_messages"]>;

export interface Report {
  reason: ReportReasons;
  message: Message;
  extra?: string;
  staff: User | false;
}

export const enum ReportReasons {
  anonReport = "anonReport",
  track = "track",
  modResolution = "modResolution",
  spam = "spam",
  automod = "automod",
}

/**
 * Record a new report in the database.
 * Returns { wasInserted: true } on success, { wasInserted: false } if duplicate.
 */
export const recordReport = (data: {
  reportedMessageId: string;
  reportedChannelId: string;
  reportedUserId: string;
  guildId: string;
  logMessageId: string;
  logChannelId: string;
  reason: ReportReasons;
  staffId?: string;
  staffUsername?: string;
  extra?: string;
}) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const reportId = crypto.randomUUID() as string;

    yield* logEffect("info", "ReportedMessage", "Recording report", {
      reportedUserId: data.reportedUserId,
      guildId: data.guildId,
      reason: data.reason,
    });

    const result = yield* db.insertInto("reported_messages").values({
      id: reportId,
      reported_message_id: data.reportedMessageId,
      reported_channel_id: data.reportedChannelId,
      reported_user_id: data.reportedUserId,
      guild_id: data.guildId,
      log_message_id: data.logMessageId,
      log_channel_id: data.logChannelId,
      reason: data.reason,
      staff_id: data.staffId,
      staff_username: data.staffUsername,
      extra: data.extra,
      created_at: new Date().toISOString(),
    });

    yield* logEffect("info", "ReportedMessage", "Report recorded", {
      reportedUserId: data.reportedUserId,
      guildId: data.guildId,
    });

    return { wasInserted: true, result, reportId };
  }).pipe(
    Effect.annotateSpans({ guildId: data.guildId, reason: data.reason }),

    Effect.withSpan("recordReport"),
  );

/**
 * Get a specific report by ID.
 */
export const getReportById = (reportId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;
    const [report] = yield* kysely
      .selectFrom("reported_messages")
      .selectAll()
      .where("id", "=", reportId);
    return report;
  }).pipe(Effect.withSpan("getReportById", { attributes: { reportId } }));

/**
 * Get all reports for a specific user in a guild.
 */
export const getReportsForUser = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    const reports = yield* kysely
      .selectFrom("reported_messages")
      .selectAll()
      .where("reported_user_id", "=", userId)
      .where("guild_id", "=", guildId);

    return reports;
  }).pipe(
    Effect.withSpan("getReportsForUser", { attributes: { userId, guildId } }),
  );

/**
 * Get all reports for a specific message.
 */
export const getReportsForMessage = (
  messageId: string,
  guildId: string,
  includeDeleted = false,
) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    let query = kysely
      .selectFrom("reported_messages")
      .selectAll()
      .where("reported_message_id", "=", messageId)
      .where("guild_id", "=", guildId);

    if (!includeDeleted) {
      query = query.where("deleted_at", "is", null);
    }

    const reports = yield* query.orderBy("created_at", "desc");

    yield* logEffect(
      "debug",
      "ReportedMessage",
      `Found ${reports.length} reports`,
      { messageId, guildId, includeDeleted },
    );

    return reports;
  }).pipe(
    Effect.withSpan("getReportsForMessage", {
      attributes: { messageId, guildId, includeDeleted },
    }),
  );

/**
 * Get report statistics for a user in a guild.
 */
export const getUserReportStats = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    const [[totalReports], [uniqueMessages], [uniqueChannels]] =
      yield* Effect.all([
        kysely
          .selectFrom("reported_messages")
          .select((eb) => eb.fn.count("id").as("count"))
          .where("reported_user_id", "=", userId)
          .where("guild_id", "=", guildId),
        kysely
          .selectFrom("reported_messages")
          .select(({ fn }) =>
            fn.count("reported_message_id").distinct().as("count"),
          )
          .where("reported_user_id", "=", userId)
          .where("guild_id", "=", guildId),
        kysely
          .selectFrom("reported_messages")
          .select(({ fn }) =>
            fn.count("reported_channel_id").distinct().as("count"),
          )
          .where("reported_user_id", "=", userId)
          .where("guild_id", "=", guildId),
      ]);

    return {
      reportCount: Number(totalReports?.count ?? 0),
      uniqueMessages: Number(uniqueMessages?.count ?? 0),
      uniqueChannels: Number(uniqueChannels?.count ?? 0),
      allReports: [] as ReportedMessage[], // Legacy compatibility
    };
  }).pipe(
    Effect.withSpan("getUserReportStats", { attributes: { userId, guildId } }),
  );

/**
 * Count distinct guilds where this user has spam reports (for cross-guild spam detection).
 */
export const getSpamReportGuildCount = (userId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    const [result] = yield* kysely
      .selectFrom("reported_messages")
      .select(({ fn }) => fn.count("guild_id").distinct().as("count"))
      .where("reported_user_id", "=", userId)
      .where("reason", "=", ReportReasons.spam);

    return Number(result?.count ?? 0);
  }).pipe(
    Effect.withSpan("getSpamReportGuildCount", { attributes: { userId } }),
  );

/**
 * Count spam reports for a user in a guild (used for auto-kick threshold).
 */
export const getSpamReportCount = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    const [result] = yield* kysely
      .selectFrom("reported_messages")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("reported_user_id", "=", userId)
      .where("guild_id", "=", guildId)
      .where("reason", "=", ReportReasons.spam);

    return Number(result?.count ?? 0);
  }).pipe(
    Effect.withSpan("getSpamReportCount", { attributes: { userId, guildId } }),
  );

/**
 * Get a comprehensive report summary for a user in a guild.
 * Combines stats, reason breakdown, time range, anonymous count,
 * and peak daily report count in concurrent queries.
 */
export const getUserReportSummary = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    const [
      stats,
      reasonBreakdown,
      [firstReportRow],
      [lastReportRow],
      [anonRow],
      [peakDayRow],
      [staffRow],
    ] = yield* Effect.all([
      getUserReportStats(userId, guildId),
      kysely
        .selectFrom("reported_messages")
        .select(["reason"])
        .select((eb) => eb.fn.count("id").as("count"))
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId)
        .groupBy("reason")
        .orderBy("count", "desc"),
      // Get first report (earliest created_at)
      kysely
        .selectFrom("reported_messages")
        .select("created_at")
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId)
        .orderBy("created_at", "asc")
        .limit(1),
      // Get last report (latest created_at)
      kysely
        .selectFrom("reported_messages")
        .select("created_at")
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId)
        .orderBy("created_at", "desc")
        .limit(1),
      kysely
        .selectFrom("reported_messages")
        .select((eb) => eb.fn.count("id").as("count"))
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId)
        .where("reason", "=", ReportReasons.anonReport),
      kysely
        .selectFrom("reported_messages")
        .select((eb) => [
          eb.fn.count("id").as("count"),
          eb.ref("created_at").as("day"),
        ])
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId)
        .groupBy(({ fn }) => fn("date", ["created_at"]))
        .orderBy("count", "desc")
        .limit(1),
      kysely
        .selectFrom("reported_messages")
        .select(({ fn }) => fn.count("staff_id").distinct().as("count"))
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId)
        .where("staff_id", "is not", null),
    ]);

    return {
      ...stats,
      reasonBreakdown: reasonBreakdown.map((r) => ({
        reason: r.reason,
        count: Number(r.count),
      })),
      firstReport: firstReportRow?.created_at ?? null,
      lastReport: lastReportRow?.created_at ?? null,
      anonymousCount: Number(anonRow?.count ?? 0),
      peakDayCount: Number(peakDayRow?.count ?? 0),
      uniqueStaffCount: Number(staffRow?.count ?? 0),
    };
  }).pipe(
    Effect.withSpan("getUserReportSummary", {
      attributes: { userId, guildId },
    }),
  );

/**
 * Get report counts grouped by month for a user in a guild.
 * Returns one row per month (YYYY-MM) over the last N months, ordered chronologically.
 * Months with zero reports are not included in the results.
 */
export const getMonthlyReportCounts = (
  userId: string,
  guildId: string,
  months = 6,
) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;
    const cutoff = new Date(
      Date.now() - months * 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    return yield* kysely
      .selectFrom("reported_messages")
      .select((eb) => [
        eb.fn("strftime", [eb.val("%Y-%m"), eb.ref("created_at")]).as("month"),
        eb.fn.count("id").as("count"),
      ])
      .where("reported_user_id", "=", userId)
      .where("guild_id", "=", guildId)
      .where("created_at", ">=", cutoff)
      .groupBy(({ fn, val, ref }) =>
        fn("strftime", [val("%Y-%m"), ref("created_at")]),
      )
      .orderBy("month", "asc");
  }).pipe(
    Effect.withSpan("getMonthlyReportCounts", {
      attributes: { userId, guildId, months },
    }),
  );

/**
 * Count reports in the last N days vs total for a user in a guild.
 */
export const getRecentReportCount = (
  userId: string,
  guildId: string,
  days = 30,
) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;
    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();

    const [[totalRow], [recentRow]] = yield* Effect.all([
      kysely
        .selectFrom("reported_messages")
        .select((eb) => eb.fn.count("id").as("count"))
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId),
      kysely
        .selectFrom("reported_messages")
        .select((eb) => eb.fn.count("id").as("count"))
        .where("reported_user_id", "=", userId)
        .where("guild_id", "=", guildId)
        .where("created_at", ">=", cutoff),
    ]);

    return {
      total: Number(totalRow?.count ?? 0),
      recent: Number(recentRow?.count ?? 0),
      days,
    };
  }).pipe(
    Effect.withSpan("getRecentReportCount", {
      attributes: { userId, guildId, days },
    }),
  );

/**
 * Get report counts grouped by channel for a user in a guild.
 */
export const getChannelBreakdown = (
  userId: string,
  guildId: string,
  limit = 5,
) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    return yield* kysely
      .selectFrom("reported_messages")
      .select(["reported_channel_id"])
      .select((eb) => eb.fn.count("id").as("count"))
      .where("reported_user_id", "=", userId)
      .where("guild_id", "=", guildId)
      .groupBy("reported_channel_id")
      .orderBy("count", "desc")
      .limit(limit);
  }).pipe(
    Effect.withSpan("getChannelBreakdown", {
      attributes: { userId, guildId, limit },
    }),
  );

/**
 * Get report counts grouped by staff member for a user in a guild.
 */
export const getStaffBreakdown = (userId: string, guildId: string, limit = 5) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    return yield* kysely
      .selectFrom("reported_messages")
      .select(["staff_id", "staff_username"])
      .select((eb) => eb.fn.count("id").as("count"))
      .where("reported_user_id", "=", userId)
      .where("guild_id", "=", guildId)
      .where("staff_id", "is not", null)
      .groupBy(["staff_id", "staff_username"])
      .orderBy("count", "desc")
      .limit(limit);
  }).pipe(
    Effect.withSpan("getStaffBreakdown", {
      attributes: { userId, guildId, limit },
    }),
  );

/**
 * Delete a report from the database.
 */
export const deleteReport = (reportId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    yield* kysely.deleteFrom("reported_messages").where("id", "=", reportId);
  }).pipe(Effect.withSpan("deleteReport", { attributes: { reportId } }));

/**
 * Mark a message as deleted in the database.
 */
export const markMessageAsDeleted = (messageId: string, guildId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    const result = yield* kysely
      .updateTable("reported_messages")
      .set("deleted_at", new Date().toISOString())
      .where("reported_message_id", "=", messageId)
      .where("guild_id", "=", guildId)
      .where("deleted_at", "is", null);

    return { updatedCount: result.length };
  }).pipe(
    Effect.withSpan("markMessageAsDeleted", {
      attributes: { messageId, guildId },
    }),
  );

/**
 * Get unique non-deleted message IDs for a user.
 */
export const getUniqueNonDeletedMessages = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const kysely = yield* DatabaseService;

    return yield* kysely
      .selectFrom("reported_messages")
      .select(["reported_message_id", "reported_channel_id"])
      .distinct()
      .where("reported_user_id", "=", userId)
      .where("guild_id", "=", guildId)
      .where("deleted_at", "is", null);
  }).pipe(
    Effect.withSpan("getUniqueNonDeletedMessages", {
      attributes: { userId, guildId },
    }),
  );

/**
 * Deletes a single Discord message and marks it as deleted in database.
 * Uses Effect-native logging.
 * @internal
 */
const deleteSingleMessage = (
  messageId: string,
  channelId: string,
  guildId: string,
) =>
  Effect.gen(function* () {
    const channel = yield* Effect.tryPromise({
      try: () => client.channels.fetch(channelId),
      catch: (error) => error,
    });

    if (!channel || !("messages" in channel)) {
      yield* logEffect(
        "warn",
        "ReportedMessage",
        "Channel not found or not a text channel",
        {
          messageId,
          channelId,
        },
      );
      return { success: false as const, messageId, error: "Channel not found" };
    }

    const result = yield* Effect.tryPromise({
      try: async () => {
        const message = await channel.messages.fetch(messageId);
        await message.delete();
        return { deleted: true };
      },
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) => {
        // If message is already deleted, that's fine - mark it as deleted in DB
        if (
          error instanceof Error &&
          error.message.includes("Unknown Message")
        ) {
          return Effect.succeed({ deleted: false, alreadyGone: true });
        }
        return Effect.fail(error);
      }),
    );

    // Mark as deleted in database
    yield* markMessageAsDeleted(messageId, guildId);

    if (result.deleted) {
      yield* logEffect("debug", "ReportedMessage", "Deleted message", {
        messageId,
      });
    } else {
      yield* logEffect("debug", "ReportedMessage", "Message already deleted", {
        messageId,
      });
    }

    return { success: true as const, messageId };
  }).pipe(
    Effect.catchAll((error) => {
      return Effect.gen(function* () {
        yield* logEffect(
          "warn",
          "ReportedMessage",
          "Failed to delete message",
          {
            messageId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return { success: false as const, messageId, error };
      });
    }),
  );

/**
 * Delete all reported messages for a user.
 * Uses Effect-native logging throughout.
 */
export const deleteAllReportedForUser = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const uniqueMessages = yield* getUniqueNonDeletedMessages(userId, guildId);

    if (uniqueMessages.length === 0) {
      yield* logEffect("info", "ReportedMessage", "No messages to delete", {
        userId,
        guildId,
      });
      return { total: 0, deleted: 0 };
    }

    yield* logEffect("info", "ReportedMessage", "Starting message deletion", {
      userId,
      guildId,
      messageCount: uniqueMessages.length,
    });

    let deleted = 0;
    const errors: { messageId: string; error: unknown }[] = [];

    for (const { reported_message_id, reported_channel_id } of uniqueMessages) {
      const result = yield* deleteSingleMessage(
        reported_message_id,
        reported_channel_id,
        guildId,
      );

      if (result.success) {
        deleted++;
      } else {
        errors.push({ messageId: reported_message_id, error: result.error });
      }
    }

    yield* logEffect("info", "ReportedMessage", "Deletion complete", {
      userId,
      guildId,
      total: uniqueMessages.length,
      deleted,
      failed: errors.length,
    });

    return { total: uniqueMessages.length, deleted };
  }).pipe(
    Effect.withSpan("deleteAllReportedForUser", {
      attributes: { userId, guildId },
    }),
  );
