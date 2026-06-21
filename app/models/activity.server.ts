import { Data, Effect } from "effect";
import { sql } from "kysely";

import {
  DatabaseService,
  type DB,
  type EffectKysely,
  type SqlError,
} from "#~/Database";
import { logEffect } from "#~/effects/observability";
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
 * Tagged error for wrapping non-Effect Promise dependency failures
 * (getOrFetchUser, getUserCohortAnalysis). We pass `cause: unknown` through
 * and never stringify it — satisfies local/no-error-string-cast.
 */
export class AnalyticsFetchError extends Data.TaggedError(
  "AnalyticsFetchError",
)<{
  readonly operation: string;
  readonly userId?: string;
  readonly cause: unknown;
}> {}

export type ActivityError = SqlError | AnalyticsFetchError;

/**
 * Creates a base query for message_stats filtered by guild, date range, and optionally user.
 * Takes db as an explicit parameter so this builder can be used from both
 * Effect-native callers (service methods) and legacy async callers (cohortAnalysis.ts).
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

interface DailyBreakdown {
  messages: number;
  word_count: number;
  react_count: number;
  avg_words: number;
  date: string;
}

export interface UserMessageAnalytics {
  dailyBreakdown: DailyBreakdown[];
  categoryBreakdown: { messages: number; channel_category: string | null }[];
  channelBreakdown: {
    messages: number;
    channel_id: string;
    name: string | null;
  }[];
  userInfo: Awaited<ReturnType<typeof getOrFetchUser>>;
}

/**
 * Free Effect function: gets complete user message analytics using composed queries.
 * Requires DatabaseService in context (provided by AppLayer/TestLayer).
 */
export const getUserMessageAnalyticsEffect = (
  guildId: string,
  userId: string,
  start: string,
  end: string,
): Effect.Effect<UserMessageAnalytics, ActivityError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect("debug", "Activity", "getUserMessageAnalytics started", {
      guildId,
      userId,
      start,
      end,
    });

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

    const [dailyResults, categoryBreakdown, channelBreakdown] =
      yield* Effect.all([dailyQuery, categoryQuery, channelQuery], {
        concurrency: "unbounded",
      });

    const userInfo = yield* Effect.tryPromise({
      try: () => getOrFetchUser(userId),
      catch: (cause) =>
        new AnalyticsFetchError({ operation: "getOrFetchUser", userId, cause }),
    });

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

    yield* logEffect("debug", "Activity", "getUserMessageAnalytics complete", {
      guildId,
      userId,
      dailyRows: dailyBreakdown.length,
    });

    return {
      dailyBreakdown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      categoryBreakdown: categoryBreakdown as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channelBreakdown: channelBreakdown as any,
      userInfo,
    };
  }).pipe(
    Effect.withSpan("Activity.getUserMessageAnalytics", {
      attributes: { guildId, userId },
    }),
  );

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

export interface TopParticipant {
  score: {
    channelScore: number;
    messageScore: number;
    wordScore: number;
    consistencyScore: number;
  };
  metadata: {
    percentZeroDays: number;
  };
  data: {
    participation: ParticipationData[];
    member: MemberData & { username: string | null | undefined };
  };
}

/**
 * Free Effect function: gets top participants for a guild/interval.
 * Requires DatabaseService in context.
 */
export const getTopParticipantsEffect = (
  guildId: MessageStats["guild_id"],
  intervalStart: string,
  intervalEnd: string,
): Effect.Effect<TopParticipant[], ActivityError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect("debug", "Activity", "getTopParticipants started", {
      guildId,
      intervalStart,
      intervalEnd,
    });

    const config = {
      count: 100,
      messageThreshold: 250,
      wordThreshold: 2200,
    };

    // Build top members query directly (avoid CTE which conflicts with EffectKysely proxy)
    const topMembersQuery = createMessageStatsQuery(
      db,
      guildId,
      intervalStart,
      intervalEnd,
    )
      .select(({ fn }) => [
        "author_id",
        fn.sum<number>("word_count").as("total_word_count"),
        fn.count<number>("author_id").as("message_count"),
        fn.sum<number>("react_count").as("total_reaction_count"),
        fn.count<number>("channel_category").distinct().as("category_count"),
        fn.count<number>("channel_id").distinct().as("channel_count"),
      ])
      .where((eb) =>
        eb.or([
          eb("channel_id", "in", ALLOWED_CHANNELS),
          eb("channel_category", "in", ALLOWED_CATEGORIES),
        ]),
      )
      .orderBy("message_count", "desc")
      .groupBy("author_id")
      .having(({ eb, or, fn }) =>
        or([
          eb(fn.count<number>("author_id"), ">=", config.messageThreshold),
          eb(fn.sum<number>("word_count"), ">=", config.wordThreshold),
        ]),
      )
      .limit(config.count);

    const topMembers = yield* topMembersQuery;

    if (topMembers.length === 0) {
      return [];
    }

    const dailyParticipationQuery = createMessageStatsQuery(
      db,
      guildId,
      intervalStart,
      intervalEnd,
    )
      .select(({ fn, eb, lit }) => [
        "author_id",
        fn.count<number>("author_id").as("message_count"),
        fn.sum<number>("word_count").as("word_count"),
        fn.count<number>("channel_id").distinct().as("channel_count"),
        fn.count<number>("channel_category").distinct().as("category_count"),
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
      .distinct()
      .groupBy("date")
      .groupBy("author_id")
      .where(
        "author_id",
        "in",
        topMembers.map((m) => m.author_id),
      );

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
          channelScore: scoreValue(member.channel_count, scoreLookups.channels),
          messageScore: scoreValue(member.message_count, scoreLookups.messages),
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

    const withUsernames = yield* Effect.forEach(
      scores,
      (s) =>
        Effect.tryPromise({
          try: () => getOrFetchUser(s.data.member.author_id),
          catch: (cause) =>
            new AnalyticsFetchError({
              operation: "getOrFetchUser",
              userId: s.data.member.author_id,
              cause,
            }),
        }).pipe(
          Effect.map((user) => ({
            ...s,
            data: {
              ...s.data,
              member: { ...s.data.member, username: user?.global_name },
            },
          })),
        ),
      { concurrency: "unbounded" },
    );

    yield* logEffect("debug", "Activity", "getTopParticipants complete", {
      guildId,
      count: withUsernames.length,
    });

    return withUsernames;
  }).pipe(
    Effect.withSpan("Activity.getTopParticipants", {
      attributes: { guildId: guildId },
    }),
  );
