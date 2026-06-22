import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";

import { DatabaseService, type DB } from "#~/Database";
import { SubscriptionService } from "#~/models/subscriptions.server";

// In-memory SQLite test layer (mirrors user.server.test.ts)
const TestSqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({ filename: ":memory:" }),
).pipe(Layer.provide(Reactivity.layer));

const TestKyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(TestSqliteLive),
);

// Provide both SqlClient (for schema setup) and DatabaseService (for service methods).
// provideMerge keeps a single memoized in-memory connection.
const TestLayer = Layer.mergeAll(TestSqliteLive, TestKyselyLive);

const testRuntime = ManagedRuntime.make(TestLayer);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTest = <A>(effect: Effect.Effect<A, any, any>) =>
  testRuntime.runPromise(effect);

beforeAll(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS guild_subscriptions (
          guild_id TEXT PRIMARY KEY,
          stripe_customer_id TEXT,
          stripe_subscription_id TEXT,
          product_tier TEXT NOT NULL DEFAULT 'free',
          status TEXT NOT NULL DEFAULT 'active',
          current_period_end TEXT,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    }),
  );
});

beforeEach(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM guild_subscriptions");
    }),
  );
});

afterAll(async () => {
  await testRuntime.dispose();
});

describe("SubscriptionService", () => {
  it("getGuildSubscription returns null for unknown guild", async () => {
    const result = await runTest(
      SubscriptionService.getGuildSubscription("unknown-guild"),
    );
    expect(result).toBeNull();
  });

  it("createOrUpdateSubscription inserts; getGuildSubscription reads it back", async () => {
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-1",
        product_tier: "paid",
        status: "active",
        stripe_customer_id: "cus_123",
      }),
    );

    const sub = await runTest(
      SubscriptionService.getGuildSubscription("guild-1"),
    );
    expect(sub).toMatchObject({
      guild_id: "guild-1",
      product_tier: "paid",
      status: "active",
      stripe_customer_id: "cus_123",
    });
  });

  it("createOrUpdateSubscription upserts on conflict (same guild_id updates, not duplicates)", async () => {
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-2",
        product_tier: "free",
        status: "active",
      }),
    );
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-2",
        product_tier: "paid",
        status: "active",
        stripe_customer_id: "cus_456",
      }),
    );

    const sub = await runTest(
      SubscriptionService.getGuildSubscription("guild-2"),
    );
    expect(sub).toMatchObject({
      product_tier: "paid",
      stripe_customer_id: "cus_456",
    });

    // Verify we only have one row for this guild
    const all = await runTest(SubscriptionService.getAllSubscriptions());
    expect(all.filter((s) => s.guild_id === "guild-2").length).toBe(1);
  });

  it("getProductTier: no sub → 'free'", async () => {
    const tier = await runTest(
      SubscriptionService.getProductTier("guild-no-sub"),
    );
    expect(tier).toBe("free");
  });

  it("getProductTier: inactive status → 'free'", async () => {
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-3",
        product_tier: "paid",
        status: "inactive",
      }),
    );
    const tier = await runTest(SubscriptionService.getProductTier("guild-3"));
    expect(tier).toBe("free");
  });

  it("getProductTier: past current_period_end → 'free'", async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-4",
        product_tier: "paid",
        status: "active",
        current_period_end: pastDate,
      }),
    );
    const tier = await runTest(SubscriptionService.getProductTier("guild-4"));
    expect(tier).toBe("free");
  });

  it("getProductTier: active + future period_end → returns stored tier", async () => {
    const futureDate = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-5",
        product_tier: "paid",
        status: "active",
        current_period_end: futureDate,
      }),
    );
    const tier = await runTest(SubscriptionService.getProductTier("guild-5"));
    expect(tier).toBe("paid");
  });

  it("updateSubscriptionStatus on existing sub → updates status", async () => {
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-6",
        product_tier: "paid",
        status: "active",
      }),
    );
    await runTest(
      SubscriptionService.updateSubscriptionStatus("guild-6", "cancelled"),
    );
    const sub = await runTest(
      SubscriptionService.getGuildSubscription("guild-6"),
    );
    expect(sub?.status).toBe("cancelled");
  });

  it("updateSubscriptionStatus on missing guild → fails with SubscriptionNotFoundError", async () => {
    const result = await runTest(
      SubscriptionService.updateSubscriptionStatus(
        "no-such-guild",
        "cancelled",
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SubscriptionNotFoundError");
    }
  });

  it("initializeFreeSubscription creates free sub when absent", async () => {
    await runTest(SubscriptionService.initializeFreeSubscription("guild-7"));
    const sub = await runTest(
      SubscriptionService.getGuildSubscription("guild-7"),
    );
    expect(sub).toMatchObject({ guild_id: "guild-7", product_tier: "free" });
  });

  it("initializeFreeSubscription is a no-op when subscription already exists", async () => {
    await runTest(
      SubscriptionService.createOrUpdateSubscription({
        guild_id: "guild-8",
        product_tier: "paid",
        status: "active",
      }),
    );
    await runTest(SubscriptionService.initializeFreeSubscription("guild-8"));
    // Tier should remain paid — the init did not overwrite it
    const sub = await runTest(
      SubscriptionService.getGuildSubscription("guild-8"),
    );
    expect(sub?.product_tier).toBe("paid");
  });

  it("getAllSubscriptions returns all seeded rows", async () => {
    await runTest(
      Effect.all([
        SubscriptionService.createOrUpdateSubscription({
          guild_id: "guild-9a",
          product_tier: "free",
        }),
        SubscriptionService.createOrUpdateSubscription({
          guild_id: "guild-9b",
          product_tier: "paid",
        }),
      ]),
    );
    const all = await runTest(SubscriptionService.getAllSubscriptions());
    expect(all.length).toBe(2);
  });

  it("auditSubscriptionChanges returns void without throwing", async () => {
    // Sentry breadcrumb is a no-op in test env; just confirm no defect
    await expect(
      runTest(
        SubscriptionService.auditSubscriptionChanges(
          "guild-audit",
          "test_event",
          {
            key: "value",
          },
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
