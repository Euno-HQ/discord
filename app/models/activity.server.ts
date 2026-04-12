import { Effect } from "effect";
import { sql } from "kysely";

import { runEffect } from "#~/AppRuntime";
import { DatabaseService, type DB, type EffectKysely } from "#~/Database";
import { getUserCohortAnalysis } from "#~/helpers/cohortAnalysis";
import { fillDateGaps } from "#~/helpers/dateUtils";
import { getOrFetchUser } from "#~/helpers/userInfoCache";

type MessageStats = DB["message_stats"];

// Default allowed channel categories for analytics
const ALLOWED_CATEGORIES: string[] = [
  "Need Help",
  "React General",
  "Advanced Topics",
];

// Default allowed channels (currently empty but can be configured)
const ALLOWED_CHANNELS: string[] = [];

/**
 * Creates a base query for message_stats filtered by guild, date range, and optionally user
 */
export function createMessageStatsQuery(
  db: EffectKysely,
  guildId: MessageStats["guild_id"],
  start: string,
  end: string,
  userId?: MessageStats["author_id"],
) {
  let query = db
    .selectFrom("message_stats")
    .where("guild_id", "=", guildId)
    .where("sent_at", ">=", new Date(start).getTime())
    .where("sent_at", "<=", new Date(end + "T23:59:59").getTime());

  if (userId) {
    query = query.where("author_id", "=", userId);
  }

  return query;
}

/**
 * Gets complete user message analytics using composed queries
 */
export async function getUserMessageAnalytics(
  guildId: string,
  userId: string,
  start: string,
  end: string,
) {
  return runEffect(
    Effect.gen(function* () {
      const db = yield* DatabaseService;

      // Build daily stats query
      const dailyQuery = createMessageStatsQuery(db, guildId, start, end, userId)
        .select(({ fn, eb, lit }) => [
          fn.countAll<number>().as("messages"),
          fn.sum<number>("word_count").as("word_count"),
          fn.sum<number>("react_count").as("react_count"),
          fn("round", [fn.avg("word_count"), lit(3)]).as("avg_words"),
          eb
            .fn("date", [eb("sent_at", "/", lit(1000)), sql.lit("unixepoch")])
            .as("date"),
        ])
        .where((eb) =>
          eb.or([
            eb("channel_id", "in", ALLOWED_CHANNELS),
            eb("channel_category", "in", ALLOWED_CATEGORIES),
          ]),
        )
        .orderBy("date", "asc")
        .groupBy("date");

      // Build category stats query
      const categoryQuery = createMessageStatsQuery(
        db,
        guildId,
        start,
        end,
        userId,
      )
        .select(({ fn }) => [
          fn.count<number>("channel_category").as("messages"),
          "channel_category",
        ])
        .where((eb) =>
          eb.or([
            eb("channel_id", "in", ALLOWED_CHANNELS),
            eb("channel_category", "in", ALLOWED_CATEGORIES),
          ]),
        )
        .groupBy("channel_category");

      // Build channel stats query
      const channelQuery = createMessageStatsQuery(
        db,
        guildId,
        start,
        end,
        userId,
      )
        // @ts-expect-error - Kysely selector typing is complex
        .select(({ fn }) => [
          fn.count<number>("channel_id").as("messages"),
          "channel_id",
          "channel.name",
        ])
        .leftJoin(
          "channel_info as channel",
          "channel.id",
          "message_stats.channel_id",
        )
        .where((eb) =>
          eb.or([
            eb("channel_id", "in", ALLOWED_CHANNELS),
            eb("channel_category", "in", ALLOWED_CATEGORIES),
          ]),
        )
        .orderBy("messages", "desc")
        .groupBy("channel_id");

      console.log("sql:", { compiled: dailyQuery.compile() });

      const [dailyResults, categoryBreakdown, channelBreakdown, userInfo] =
        yield* Effect.all(
          [
            dailyQuery,
            categoryQuery,
            channelQuery,
            Effect.tryPromise({
              try: () => getOrFetchUser(userId),
              catch: (e) => e,
            }),
          ],
        ).pipe(Effect.withConcurrency("unbounded"));

      interface DailyBreakdown {
        messages: number;
        word_count: number;
        react_count: number;
        avg_words: number;
        date: string;
      }
      // Only daily breakdown needs date gap filling
      const dailyBreakdown = fillDateGaps<DailyBreakdown>(
        dailyResults as DailyBreakdown[],
        start,
        end,
        {
          messages: 0,
          word_count: 0,
          react_count: 0,
          avg_words: 0,
        },
      );

      return { dailyBreakdown, categoryBreakdown, channelBreakdown, userInfo };
    }),
  );
}

export async function getEnhancedUserAnalytics(
  guildId: string,
  userId: string,
  start: string,
  end: string,
) {
  const [basicAnalytics, cohortComparison] = await Promise.all([
    getUserMessageAnalytics(guildId, userId, start, end),
    getUserCohortAnalysis(guildId, userId, start, end),
  ]);

  return {
    ...basicAnalytics,
    cohortComparison,
  };
}

export async function getTopParticipants(
  guildId: MessageStats["guild_id"],
  intervalStart: string,
  intervalEnd: string,
) {
  return runEffect(
    Effect.gen(function* () {
      const db = yield* DatabaseService;

      const config = {
        count: 100,
        messageThreshold: 250,
        wordThreshold: 2200,
      };

      const baseQuery = createMessageStatsQuery(
        db,
        guildId,
        intervalStart,
        intervalEnd,
      )
        .selectAll()
        .select(({ fn, eb, lit }) => [
          fn("date", [eb("sent_at", "/", lit(1000)), sql.lit("unixepoch")]).as(
            "date",
          ),
        ]);

      // Apply channel filtering inline
      const filteredQuery = baseQuery.where((eb) =>
        eb.or([
          eb("channel_id", "in", ALLOWED_CHANNELS),
          eb("channel_category", "in", ALLOWED_CATEGORIES),
        ]),
      );

      // get shortlist using inline selectors
      const topMembersQuery = db
        .with("interval_message_stats", () => filteredQuery)
        // .with("interval_message_stats", () => baseQuery)
        .selectFrom("interval_message_stats")
        .select(({ fn }) => [
          "author_id",
          fn.sum<number>("word_count").as("total_word_count"),
          fn.count<number>("author_id").as("message_count"),
          fn.sum<number>("react_count").as("total_reaction_count"),
          fn.count<number>("channel_category").distinct().as("category_count"),
          fn.count<number>("channel_id").distinct().as("channel_count"),
        ])
        .orderBy("message_count desc")
        .groupBy("author_id")
        .having(({ eb, or, fn }) =>
          or([
            eb(fn.count<number>("author_id"), ">=", config.messageThreshold),
            eb(fn.sum<number>("word_count"), ">=", config.wordThreshold),
          ]),
        )
        .limit(config.count);
      console.log(topMembersQuery.compile().sql);
      const topMembers = yield* topMembersQuery;

      const dailyParticipationQuery = db
        .with("interval_message_stats", () => filteredQuery)
        // .with("interval_message_stats", () => baseQuery)
        .selectFrom("interval_message_stats")
        .select(({ fn }) => [
          "author_id",
          "date",
          fn.count<number>("author_id").as("message_count"),
          fn.sum<number>("word_count").as("word_count"),
          fn.count<number>("channel_id").distinct().as("channel_count"),
          fn.count<number>("channel_category").distinct().as("category_count"),
        ])
        .distinct()
        .groupBy("date")
        .groupBy("author_id")
        .where(
          "author_id",
          "in",
          topMembers.map((m) => m.author_id),
        );
      console.log(dailyParticipationQuery.compile().sql);
      const rawDailyParticipation = yield* dailyParticipationQuery;
      // Group by author and fill date gaps inline
      const groupedData = rawDailyParticipation.reduce((acc, record) => {
        const { author_id, date } = record;
        if (!acc[author_id]) acc[author_id] = [];
        acc[author_id].push({ ...record, date: date as string });
        return acc;
      }, {} as GroupedResult);

      const dailyParticipation: GroupedResult = {};
      for (const authorId in groupedData) {
        dailyParticipation[authorId] = fillDateGaps(
          groupedData[authorId],
          intervalStart,
          intervalEnd,
          {
            message_count: 0,
            word_count: 0,
            channel_count: 0,
            category_count: 0,
          },
        );
      }

      const scores = topMembers.map((m) => {
        const member = m as MemberData;
        const participation = dailyParticipation[member.author_id];
        const categoryCounts = participation
          .map((p) => p.category_count)
          .sort((a, b) => a - b);
        const zeroDays = participation.filter(
          (p) => p.message_count === 0,
        ).length;

        return {
          score: {
            channelScore: scoreValue(
              member.channel_count,
              scoreLookups.channels,
            ),
            messageScore: scoreValue(
              member.message_count,
              scoreLookups.messages,
            ),
            wordScore: scoreValue(member.total_word_count, scoreLookups.words),
            consistencyScore: Math.ceil(
              categoryCounts[Math.floor(categoryCounts.length / 2)],
            ),
          },
          metadata: {
            percentZeroDays: zeroDays / participation.length,
          },
          data: { participation, member },
        };
      });

      const withUsernames = yield* Effect.all(
        scores.map((scores) =>
          Effect.tryPromise({
            try: () => getOrFetchUser(scores.data.member.author_id),
            catch: (e) => e,
          }).pipe(
            Effect.map((user) => ({
              ...scores,
              data: {
                ...scores.data,
                member: {
                  ...scores.data.member,
                  username: user?.global_name,
                },
              },
            })),
          ),
        ),
      ).pipe(Effect.withConcurrency("unbounded"));

      return withUsernames;
    }),
  );
}

// copy-pasted out of TopMembers query result
interface MemberData {
  author_id: string;
  total_word_count: number;
  message_count: number;
  total_reaction_count: number;
  category_count: number;
  channel_count: number;
}
function scoreValue(test: number, lookup: [number, number][]) {
  return lookup.reduce((score, [min, value], i, list) => {
    const max = list[i + 1]?.[0] ?? Infinity;
    return test >= min && test < max ? value : score;
  }, 0);
}
// prettier-ignore
const scoreLookups = {
  words: [ [0, 0], [2000, 1], [5000, 2], [7500, 3], [20000, 4], ],
  messages: [ [0, 0], [150, 1], [350, 2], [800, 3], [1500, 4], ],
  channels: [ [0, 0], [3, 1], [7, 2], [9, 3], ],
} as { words: [number, number][]; messages: [number, number][]; channels: [number, number][] };

interface ParticipationData {
  date: string;
  message_count: number;
  word_count: number;
  channel_count: number;
  category_count: number;
}

type GroupedResult = Record<string, ParticipationData[]>;
