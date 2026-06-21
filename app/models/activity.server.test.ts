import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";

import { DatabaseService, type DB } from "#~/Database";
import {
  AnalyticsFetchError,
  getTopParticipantsEffect,
  getUserMessageAnalyticsEffect,
} from "#~/models/activity.server";

// --- mock userInfoCache so tests don't hit Discord ---
vi.mock("#~/helpers/userInfoCache", () => ({
  getOrFetchUser: vi.fn().mockResolvedValue({
    id: "user-1",
    username: "testuser",
    global_name: "Test User",
  }),
}));

// In-memory SQLite test layer (mirrors app/models/user.server.test.ts)
const TestSqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({ filename: ":memory:" }),
).pipe(Layer.provide(Reactivity.layer));

const TestKyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(TestSqliteLive),
);

// provideMerge keeps a single memoized in-memory connection.
const TestBase = Layer.mergeAll(TestSqliteLive, TestKyselyLive);

const testRuntime = ManagedRuntime.make(TestBase);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTest = <A>(effect: Effect.Effect<A, any, any>) =>
  testRuntime.runPromise(effect);

beforeAll(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS message_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          channel_category TEXT,
          sent_at INTEGER NOT NULL,
          word_count INTEGER DEFAULT 0,
          react_count INTEGER DEFAULT 0,
          code_stats TEXT
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS channel_info (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT
        )
      `);
    }),
  );
});

beforeEach(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM message_stats");
      yield* sql.unsafe("DELETE FROM channel_info");
    }),
  );
});

afterAll(async () => {
  await testRuntime.dispose();
});

// Helper: insert a message_stats row
function insertMessage(
  sql: SqlClient.SqlClient,
  opts: {
    guild_id: string;
    author_id: string;
    channel_id: string;
    channel_category?: string | null;
    sent_at: number; // unix ms
    word_count?: number;
    react_count?: number;
  },
) {
  return sql.unsafe(`
    INSERT INTO message_stats (guild_id, author_id, channel_id, channel_category, sent_at, word_count, react_count)
    VALUES ('${opts.guild_id}', '${opts.author_id}', '${opts.channel_id}', ${opts.channel_category ? `'${opts.channel_category}'` : "NULL"}, ${opts.sent_at}, ${opts.word_count ?? 0}, ${opts.react_count ?? 0})
  `);
}

// A date in ms for a known date string
function dateMs(dateStr: string): number {
  return new Date(dateStr).getTime();
}

describe("getUserMessageAnalyticsEffect", () => {
  it("returns gap-filled dailyBreakdown, aggregated categoryBreakdown and channelBreakdown", async () => {
    const guildId = "guild-1";
    const userId = "user-1";
    const start = "2024-01-01";
    const end = "2024-01-03";

    await runTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Day 1: two messages in an allowed category
        yield* insertMessage(sql, {
          guild_id: guildId,
          author_id: userId,
          channel_id: "chan-1",
          channel_category: "Need Help",
          sent_at: dateMs("2024-01-01T10:00:00Z"),
          word_count: 10,
          react_count: 2,
        });
        yield* insertMessage(sql, {
          guild_id: guildId,
          author_id: userId,
          channel_id: "chan-1",
          channel_category: "Need Help",
          sent_at: dateMs("2024-01-01T12:00:00Z"),
          word_count: 5,
          react_count: 1,
        });
        // Day 3: one message (day 2 will be a gap)
        yield* insertMessage(sql, {
          guild_id: guildId,
          author_id: userId,
          channel_id: "chan-2",
          channel_category: "React General",
          sent_at: dateMs("2024-01-03T09:00:00Z"),
          word_count: 20,
          react_count: 0,
        });
        // channel_info
        yield* sql.unsafe(
          `INSERT INTO channel_info (id, name) VALUES ('chan-1', 'help-channel')`,
        );
        yield* sql.unsafe(
          `INSERT INTO channel_info (id, name) VALUES ('chan-2', 'react-general')`,
        );
      }),
    );

    const result = await runTest(
      getUserMessageAnalyticsEffect(guildId, userId, start, end),
    );

    // dailyBreakdown should have 3 entries (gap-filled)
    expect(result.dailyBreakdown).toHaveLength(3);
    const day1 = result.dailyBreakdown.find((d) => d.date === "2024-01-01");
    const day2 = result.dailyBreakdown.find((d) => d.date === "2024-01-02");
    const day3 = result.dailyBreakdown.find((d) => d.date === "2024-01-03");

    expect(day1).toBeDefined();
    expect(Number(day1!.messages)).toBe(2);
    expect(Number(day1!.word_count)).toBe(15);
    expect(Number(day1!.react_count)).toBe(3);

    // Day 2 is a zero-fill
    expect(day2).toBeDefined();
    expect(Number(day2!.messages)).toBe(0);

    expect(day3).toBeDefined();
    expect(Number(day3!.messages)).toBe(1);

    // categoryBreakdown
    const needHelp = result.categoryBreakdown.find(
      (c) => c.channel_category === "Need Help",
    );
    expect(needHelp).toBeDefined();
    expect(Number(needHelp!.messages)).toBe(2);

    // channelBreakdown includes channel name from join
    const chan1 = result.channelBreakdown.find(
      (c) => c.channel_id === "chan-1",
    );
    expect(chan1).toBeDefined();
    // The name field is aliased as "channel.name" — check it's present
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((chan1 as any).name).toBe("help-channel");

    // userInfo is from the mock
    expect(result.userInfo).toBeDefined();
  });

  it("returns all-zero dailyBreakdown for an empty date range", async () => {
    const result = await runTest(
      getUserMessageAnalyticsEffect(
        "guild-1",
        "user-1",
        "2024-02-01",
        "2024-02-03",
      ),
    );
    expect(result.dailyBreakdown).toHaveLength(3);
    result.dailyBreakdown.forEach((d) => {
      expect(Number(d.messages)).toBe(0);
    });
    expect(result.categoryBreakdown).toHaveLength(0);
    expect(result.channelBreakdown).toHaveLength(0);
  });

  it("excludes rows not in ALLOWED_CATEGORIES or ALLOWED_CHANNELS", async () => {
    const guildId = "guild-filter";
    const userId = "user-filter";
    await runTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // This row should be excluded (category not in allowed list)
        yield* insertMessage(sql, {
          guild_id: guildId,
          author_id: userId,
          channel_id: "chan-bad",
          channel_category: "Off Topic",
          sent_at: dateMs("2024-03-01T10:00:00Z"),
          word_count: 100,
        });
        // This row should be included (allowed category)
        yield* insertMessage(sql, {
          guild_id: guildId,
          author_id: userId,
          channel_id: "chan-good",
          channel_category: "Advanced Topics",
          sent_at: dateMs("2024-03-01T11:00:00Z"),
          word_count: 50,
        });
      }),
    );

    const result = await runTest(
      getUserMessageAnalyticsEffect(
        guildId,
        userId,
        "2024-03-01",
        "2024-03-01",
      ),
    );

    // Only 1 message (the allowed one)
    const day = result.dailyBreakdown.find((d) => d.date === "2024-03-01");
    expect(day).toBeDefined();
    expect(Number(day!.messages)).toBe(1);
    expect(Number(day!.word_count)).toBe(50);
  });

  it("surfaces AnalyticsFetchError when getOrFetchUser rejects", async () => {
    const { getOrFetchUser } = await import("#~/helpers/userInfoCache");
    vi.mocked(getOrFetchUser).mockRejectedValueOnce(new Error("network fail"));

    const exit = await testRuntime.runPromiseExit(
      getUserMessageAnalyticsEffect(
        "guild-1",
        "user-err",
        "2024-01-01",
        "2024-01-01",
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      // The failure cause has _tag "Fail" with an .error property
      expect((cause as { _tag: string })._tag).toBe("Fail");
      // Walk to the error
      const err = (cause as { _tag: string; error: unknown }).error;
      expect(err).toBeInstanceOf(AnalyticsFetchError);
      expect((err as AnalyticsFetchError).operation).toBe("getOrFetchUser");
    }
  });
});

describe("getTopParticipantsEffect", () => {
  it("returns only users meeting message or word threshold, with score and metadata", async () => {
    const guildId = "guild-top";
    const start = "2024-04-01";
    const end = "2024-04-30";

    // messageThreshold = 250, wordThreshold = 2200
    // user-above: 300 messages, 3000 words → qualifies
    // user-below: 10 messages, 100 words → excluded

    await runTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Insert 300 messages for user-above spread across 3 days
        for (let i = 0; i < 300; i++) {
          const day = (i % 3) + 1;
          yield* insertMessage(sql, {
            guild_id: guildId,
            author_id: "user-above",
            channel_id: "chan-1",
            channel_category: "Need Help",
            sent_at: dateMs(`2024-04-0${day}T10:00:00Z`),
            word_count: 10, // 300*10=3000 words total
            react_count: 1,
          });
        }
        // Insert 10 messages for user-below (doesn't qualify)
        for (let i = 0; i < 10; i++) {
          yield* insertMessage(sql, {
            guild_id: guildId,
            author_id: "user-below",
            channel_id: "chan-2",
            channel_category: "React General",
            sent_at: dateMs(`2024-04-01T10:00:00Z`),
            word_count: 10,
            react_count: 0,
          });
        }
      }),
    );

    const results = await runTest(
      getTopParticipantsEffect(guildId, start, end),
    );

    // Only user-above should appear
    expect(results.length).toBe(1);
    const top = results[0];
    expect(top.data.member.author_id).toBe("user-above");

    // Score fields present
    expect(typeof top.score.messageScore).toBe("number");
    expect(typeof top.score.wordScore).toBe("number");
    expect(typeof top.score.channelScore).toBe("number");
    expect(typeof top.score.consistencyScore).toBe("number");

    // Metadata present
    expect(typeof top.metadata.percentZeroDays).toBe("number");

    // Username from mock
    expect(top.data.member.username).toBe("Test User");
  });

  it("returns empty array when no users meet the threshold", async () => {
    const results = await runTest(
      getTopParticipantsEffect("guild-empty", "2024-05-01", "2024-05-31"),
    );
    expect(results).toHaveLength(0);
  });
});
