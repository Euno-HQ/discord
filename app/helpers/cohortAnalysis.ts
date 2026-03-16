import { sql } from "kysely";
import { partition } from "lodash-es";

import { run } from "#~/AppRuntime";
import type { CodeStats } from "#~/helpers/discord";
import { descriptiveStats, percentile } from "#~/helpers/statistics";
import { createMessageStatsQuery } from "#~/models/activity.server";

import { fillDateGaps } from "./dateUtils";

const performanceThresholds = [
  { min: 90, value: "top" },
  { min: 70, value: "above_average" },
  { min: 30, value: "average" },
  { min: 10, value: "below_average" },
  { min: -Infinity, value: "bottom" },
] as const;

interface MetricConfig {
  key: "messageCount" | "reactionCount" | "codeChars" | "longestStreak";
  strength: string;
  improvement: string;
}

const metricsConfig: MetricConfig[] = [
  {
    key: "messageCount",
    strength: "High message volume",
    improvement: "Message frequency",
  },
  {
    key: "reactionCount",
    strength: "Strong community engagement",
    improvement: "Community engagement",
  },
  {
    key: "codeChars",
    strength: "Significant code contributions",
    improvement: "Code sharing",
  },
  {
    key: "longestStreak",
    strength: "Excellent consistency",
    improvement: "Activity consistency",
  },
] as const;

export interface UserCohortMetrics {
  userId: string;
  messageCount: number;
  wordCount: number;
  reactionCount: number;
  codeStats: {
    totalChars: number;
    totalLines: number;
    languageBreakdown: Record<string, number>;
    topLanguages: {
      language: string;
      chars: number;
      percentage: number;
    }[];
  };
  streakData: {
    longestStreak: number;
    currentStreak: number;
    consistencyScore: number;
    activeDays: number;
    totalDays: number;
  };
}

export interface CohortBenchmarks {
  messageCount: PercentileBenchmarks;
  wordCount: PercentileBenchmarks;
  reactionCount: PercentileBenchmarks;
  codeChars: PercentileBenchmarks;
  codeLines: PercentileBenchmarks;
  longestStreak: PercentileBenchmarks;
  consistencyScore: PercentileBenchmarks;
  languageDistribution: Record<string, PercentileBenchmarks>;
}

export interface PercentileBenchmarks {
  p10: number;
  p25: number;
  p50: number; // median
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
}

export interface UserCohortComparison {
  user: UserCohortMetrics;
  percentiles: {
    messageCount: number;
    wordCount: number;
    reactionCount: number;
    codeChars: number;
    codeLines: number;
    longestStreak: number;
    consistencyScore: number;
    topLanguagePercentiles: Record<string, number>;
  };
  rankings: {
    messageCount: { rank: number; total: number };
    wordCount: { rank: number; total: number };
    reactionCount: { rank: number; total: number };
    codeChars: { rank: number; total: number };
    longestStreak: { rank: number; total: number };
  };
  cohortInsights: {
    overallPerformance:
      | "top"
      | "above_average"
      | "average"
      | "below_average"
      | "bottom";
    strengths: string[];
    improvementAreas: string[];
  };
}

function calculatePercentileBenchmarks(data: number[]): PercentileBenchmarks {
  if (data.length === 0) {
    const empty = {
      p10: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      stdDev: 0,
      min: 0,
      max: 0,
    };
    return empty;
  }

  const stats = descriptiveStats(data);

  return {
    p10: percentile(data, 0.1),
    p25: percentile(data, 0.25),
    p50: percentile(data, 0.5),
    p75: percentile(data, 0.75),
    p90: percentile(data, 0.9),
    p95: percentile(data, 0.95),
    p99: percentile(data, 0.99),
    mean: stats.mean,
    stdDev: stats.standardDeviation,
    min: stats.min,
    max: stats.max,
  };
}

function calculateUserPercentile(value: number, data: number[]): number {
  if (data.length === 0) return 0;

  const sortedData = data.slice(0).sort((a, b) => a - b);
  const rank = sortedData.filter((x) => x <= value).length;
  return (rank / sortedData.length) * 100;
}

function calculateStreakData(
  dailyActivity: { date: string; messageCount: number }[],
): UserCohortMetrics["streakData"] {
  const sortedActivity = dailyActivity.sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  let longestStreak = 0;
  let currentStreak = 0;
  let tempStreak = 0;
  let activeDays = 0;

  for (const { messageCount } of sortedActivity) {
    const hasActivity = messageCount > 0;

    if (hasActivity) {
      activeDays++;
      tempStreak++;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else {
      tempStreak = 0;
    }
  }

  // Calculate current streak from the end
  for (let i = sortedActivity.length - 1; i >= 0; i--) {
    if (sortedActivity[i].messageCount > 0) {
      currentStreak++;
    } else {
      break;
    }
  }

  const totalDays = sortedActivity.length;
  const consistencyScore = totalDays > 0 ? (activeDays / totalDays) * 100 : 0;

  return {
    longestStreak,
    currentStreak,
    consistencyScore,
    activeDays,
    totalDays,
  };
}

function aggregateCodeStats(
  codeStatsJson: string[],
): UserCohortMetrics["codeStats"] {
  const validCodeStats = codeStatsJson.flatMap((jsonStr) => {
    try {
      return JSON.parse(jsonStr) as CodeStats[];
    } catch {
      return [];
    }
  });

  const { totalChars, totalLines, languageBreakdown } = validCodeStats.reduce(
    (acc, stat) => ({
      totalChars: acc.totalChars + stat.chars,
      totalLines: acc.totalLines + stat.lines,
      languageBreakdown: {
        ...acc.languageBreakdown,
        ...(stat.lang && {
          [stat.lang]: (acc.languageBreakdown[stat.lang] || 0) + stat.chars,
        }),
      },
    }),
    {
      totalChars: 0,
      totalLines: 0,
      languageBreakdown: {} as Record<string, number>,
    },
  );

  const topLanguages = Object.entries(languageBreakdown)
    .map(([language, chars]) => ({
      language,
      chars,
      percentage: totalChars > 0 ? (chars / totalChars) * 100 : 0,
    }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);

  return {
    totalChars,
    totalLines,
    languageBreakdown,
    topLanguages,
  };
}

export async function getCohortMetrics(
  guildId: string,
  start: string,
  end: string,
  minMessageThreshold = 10,
): Promise<UserCohortMetrics[]> {
  // Get aggregated user data
  const userStatsQuery = createMessageStatsQuery(guildId, start, end)
    .select((eb) => [
      "author_id",
      eb.fn.count<number>("author_id").as("message_count"),
      eb.fn.sum<number>("word_count").as("word_count"),
      eb.fn.sum<number>("react_count").as("reaction_count"),
      eb.fn("group_concat", ["code_stats", eb.lit("|||")]).as("code_stats_json"),
      eb
        .fn("date", [eb("sent_at", "/", eb.lit(1000)), sql.lit("unixepoch")])
        .as("date"),
    ])
    .groupBy("author_id")
    .having((eb) =>
      eb(eb.fn.count<number>("author_id"), ">=", minMessageThreshold),
    );

  const userStats = await run(userStatsQuery);

  // Get daily activity for streak calculation
  const dailyActivityQuery = createMessageStatsQuery(guildId, start, end)
    .select(({ fn, eb, lit }) => [
      "author_id",
      fn.count<number>("author_id").as("message_count"),
      eb
        .fn("date", [eb("sent_at", "/", lit(1000)), sql.lit("unixepoch")])
        .as("date"),
    ])
    .groupBy(["author_id", "date"])
    .where(
      "author_id",
      "in",
      userStats.map((u) => u.author_id),
    );

  const dailyActivity = await run(dailyActivityQuery);

  // Group daily activity by user
  const dailyActivityByUser = dailyActivity.reduce(
    (acc, record) => {
      const userId = record.author_id;
      if (!acc[userId]) acc[userId] = [];
      acc[userId].push({
        date: record.date as string,
        messageCount: record.message_count,
      });
      return acc;
    },
    {} as Record<string, { date: string; messageCount: number }[]>,
  );

  return userStats.map((user) => {
    const codeStatsArray = user.code_stats_json
      ? user.code_stats_json.split("|||").filter(Boolean)
      : [];

    const userDailyActivity = fillDateGaps(
      dailyActivityByUser[user.author_id] || [],
      start,
      end,
      { messageCount: 0 },
    );

    return {
      userId: user.author_id,
      messageCount: user.message_count,
      wordCount: user.word_count || 0,
      reactionCount: user.reaction_count || 0,
      codeStats: aggregateCodeStats(codeStatsArray),
      streakData: calculateStreakData(userDailyActivity),
    };
  });
}

export function calculateCohortBenchmarks(
  cohortMetrics: UserCohortMetrics[],
): CohortBenchmarks {
  if (cohortMetrics.length === 0) {
    const empty = {
      p10: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      stdDev: 0,
      min: 0,
      max: 0,
    };
    return {
      messageCount: empty,
      wordCount: empty,
      reactionCount: empty,
      codeChars: empty,
      codeLines: empty,
      longestStreak: empty,
      consistencyScore: empty,
      languageDistribution: {},
    };
  }

  // Extract arrays for each metric
  const messageCounts = cohortMetrics.map((u) => u.messageCount);
  const wordCounts = cohortMetrics.map((u) => u.wordCount);
  const reactionCounts = cohortMetrics.map((u) => u.reactionCount);
  const codeChars = cohortMetrics.map((u) => u.codeStats.totalChars);
  const codeLines = cohortMetrics.map((u) => u.codeStats.totalLines);
  const longestStreaks = cohortMetrics.map((u) => u.streakData.longestStreak);
  const consistencyScores = cohortMetrics.map(
    (u) => u.streakData.consistencyScore,
  );

  // Calculate language distribution benchmarks
  const allLanguages = new Set(
    cohortMetrics.flatMap((user) =>
      Object.keys(user.codeStats.languageBreakdown),
    ),
  );

  const languageDistribution = Array.from(allLanguages).reduce(
    (acc, language) => {
      acc[language] = calculatePercentileBenchmarks(
        cohortMetrics.map((u) => u.codeStats.languageBreakdown[language]),
      );
      return acc;
    },
    {} as Record<string, PercentileBenchmarks>,
  );

  return {
    messageCount: calculatePercentileBenchmarks(messageCounts),
    wordCount: calculatePercentileBenchmarks(wordCounts),
    reactionCount: calculatePercentileBenchmarks(reactionCounts),
    codeChars: calculatePercentileBenchmarks(codeChars),
    codeLines: calculatePercentileBenchmarks(codeLines),
    longestStreak: calculatePercentileBenchmarks(longestStreaks),
    consistencyScore: calculatePercentileBenchmarks(consistencyScores),
    languageDistribution,
  };
}

export function compareUserToCohort(
  userMetrics: UserCohortMetrics,
  cohortMetrics: UserCohortMetrics[],
): UserCohortComparison {
  // Calculate percentiles
  const messageCounts = cohortMetrics.map((u) => u.messageCount);
  const wordCounts = cohortMetrics.map((u) => u.wordCount);
  const reactionCounts = cohortMetrics.map((u) => u.reactionCount);
  const codeChars = cohortMetrics.map((u) => u.codeStats.totalChars);
  const codeLines = cohortMetrics.map((u) => u.codeStats.totalLines);
  const longestStreaks = cohortMetrics.map((u) => u.streakData.longestStreak);
  const consistencyScores = cohortMetrics.map(
    (u) => u.streakData.consistencyScore,
  );

  const percentiles = {
    messageCount: calculateUserPercentile(
      userMetrics.messageCount,
      messageCounts,
    ),
    wordCount: calculateUserPercentile(userMetrics.wordCount, wordCounts),
    reactionCount: calculateUserPercentile(
      userMetrics.reactionCount,
      reactionCounts,
    ),
    codeChars: calculateUserPercentile(
      userMetrics.codeStats.totalChars,
      codeChars,
    ),
    codeLines: calculateUserPercentile(
      userMetrics.codeStats.totalLines,
      codeLines,
    ),
    longestStreak: calculateUserPercentile(
      userMetrics.streakData.longestStreak,
      longestStreaks,
    ),
    consistencyScore: calculateUserPercentile(
      userMetrics.streakData.consistencyScore,
      consistencyScores,
    ),
    // Calculate language percentiles for user's top languages
    topLanguagePercentiles: userMetrics.codeStats.topLanguages.reduce(
      (acc, { language }) => {
        acc[language] = calculateUserPercentile(
          userMetrics.codeStats.languageBreakdown[language] || 0,
          cohortMetrics.map(
            (u) => u.codeStats.languageBreakdown[language] || 0,
          ),
        );
        return acc;
      },
      {} as Record<string, number>,
    ),
  };

  // Calculate rankings
  const rankings = {
    messageCount: {
      rank:
        messageCounts.filter((count) => count > userMetrics.messageCount)
          .length + 1,
      total: messageCounts.length,
    },
    wordCount: {
      rank:
        wordCounts.filter((count) => count > userMetrics.wordCount).length + 1,
      total: wordCounts.length,
    },
    reactionCount: {
      rank:
        reactionCounts.filter((count) => count > userMetrics.reactionCount)
          .length + 1,
      total: reactionCounts.length,
    },
    codeChars: {
      rank:
        codeChars.filter((chars) => chars > userMetrics.codeStats.totalChars)
          .length + 1,
      total: codeChars.length,
    },
    longestStreak: {
      rank:
        longestStreaks.filter(
          (streak) => streak > userMetrics.streakData.longestStreak,
        ).length + 1,
      total: longestStreaks.length,
    },
  };

  // Generate insights
  const avgPercentile =
    (percentiles.messageCount +
      percentiles.wordCount +
      percentiles.reactionCount +
      percentiles.longestStreak) /
    4;

  const overallPerformance = performanceThresholds.find(
    (t) => avgPercentile >= t.min,
  )!.value;

  const [strengthConfigs, improvementConfigs] = partition(
    metricsConfig,
    (config) => percentiles[config.key] >= 50,
  );

  const strengths = strengthConfigs.map((config) => config.strength);
  const improvementAreas = improvementConfigs.map(
    (config) => config.improvement,
  );

  return {
    user: userMetrics,
    percentiles,
    rankings,
    cohortInsights: {
      overallPerformance,
      strengths,
      improvementAreas,
    },
  };
}

export async function getUserCohortAnalysis(
  guildId: string,
  userId: string,
  start: string,
  end: string,
  minMessageThreshold = 10,
) {
  const cohortMetrics = await getCohortMetrics(
    guildId,
    start,
    end,
    minMessageThreshold,
  );
  const userMetrics = cohortMetrics.find((u) => u.userId === userId);
  if (!userMetrics) return null;
  return compareUserToCohort(userMetrics, cohortMetrics);
}
