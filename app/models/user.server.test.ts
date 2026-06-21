import { Effect, Layer, ManagedRuntime } from "effect";
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

import { DatabaseService } from "#~/Database";
import type { DB } from "#~/db";
import { UserService, UserServiceLive } from "#~/models/user.server";

// Stub out the side-effectful AppRuntime (DB connection + PostHog init) that
// user.server.ts's legacy functions import. Without this mock, loading
// AppRuntime triggers a real DB open and creates a circular-import cycle that
// makes UserServiceLive undefined at test-layer composition time.
vi.mock("#~/AppRuntime", () => ({
  db: undefined,
  run: vi.fn(),
  runTakeFirst: vi.fn(),
  runTakeFirstOrThrow: vi.fn(),
  posthogClient: null,
  runtime: { runPromise: vi.fn() },
}));

// In-memory SQLite test layer (mirrors app/jobs/jobRunner.test.ts)
const TestSqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({ filename: ":memory:" }),
).pipe(Layer.provide(Reactivity.layer));

const TestKyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(TestSqliteLive),
);

// Provide the test DB to UserServiceLive, and also expose SqlClient/DatabaseService
// for schema setup. provideMerge keeps a single memoized in-memory connection.
const TestBase = Layer.mergeAll(TestSqliteLive, TestKyselyLive);
const TestLayer = Layer.provideMerge(UserServiceLive, TestBase);

const testRuntime = ManagedRuntime.make(TestLayer);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTest = <A>(effect: Effect.Effect<A, any, any>) =>
  testRuntime.runPromise(effect);

beforeAll(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY NOT NULL,
          externalId TEXT NOT NULL,
          email TEXT,
          authProvider TEXT
        )
      `);
    }),
  );
});

beforeEach(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM users");
    }),
  );
});

afterAll(async () => {
  await testRuntime.dispose();
});

describe("UserService", () => {
  it("createUser inserts a row and getUserById reads it back", async () => {
    const id = await runTest(
      Effect.flatMap(UserService, (s) => s.createUser("a@b.com", "ext-1")),
    );
    expect(typeof id).toBe("string");

    const user = await runTest(
      Effect.flatMap(UserService, (s) => s.getUserById(id)),
    );
    expect(user).toMatchObject({
      id,
      email: "a@b.com",
      externalId: "ext-1",
      authProvider: "discord",
    });
  });

  it("getUserById returns undefined for an unknown id", async () => {
    const user = await runTest(
      Effect.flatMap(UserService, (s) => s.getUserById("nope")),
    );
    expect(user).toBeUndefined();
  });

  it("getUserByExternalId finds a user and returns undefined when absent", async () => {
    await runTest(
      Effect.flatMap(UserService, (s) => s.createUser("c@d.com", "ext-2")),
    );
    const found = await runTest(
      Effect.flatMap(UserService, (s) => s.getUserByExternalId("ext-2")),
    );
    expect(found?.email).toBe("c@d.com");

    const missing = await runTest(
      Effect.flatMap(UserService, (s) => s.getUserByExternalId("ext-missing")),
    );
    expect(missing).toBeUndefined();
  });

  it("getUserByEmail finds a user and returns undefined when absent", async () => {
    await runTest(
      Effect.flatMap(UserService, (s) => s.createUser("e@f.com", "ext-3")),
    );
    const found = await runTest(
      Effect.flatMap(UserService, (s) => s.getUserByEmail("e@f.com")),
    );
    expect(found?.externalId).toBe("ext-3");

    const missing = await runTest(
      Effect.flatMap(UserService, (s) => s.getUserByEmail("ghost@nowhere.com")),
    );
    expect(missing).toBeUndefined();
  });

  it("deleteUserByEmail removes the row", async () => {
    await runTest(
      Effect.flatMap(UserService, (s) => s.createUser("g@h.com", "ext-4")),
    );
    await runTest(
      Effect.flatMap(UserService, (s) => s.deleteUserByEmail("g@h.com")),
    );
    const after = await runTest(
      Effect.flatMap(UserService, (s) => s.getUserByEmail("g@h.com")),
    );
    expect(after).toBeUndefined();
  });
});
