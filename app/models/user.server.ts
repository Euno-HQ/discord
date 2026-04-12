import { randomUUID } from "crypto";

import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { DatabaseService, type DB } from "#~/Database";
import { NotFoundError } from "#~/effects/errors";
import { log, trackPerformance } from "#~/helpers/observability";

export type User = DB["users"];

export async function getUserById(id: User["id"]) {
  return trackPerformance(
    "getUserById",
    async () => {
      log("debug", "User", "Fetching user by ID", { userId: id });

      const user = await runEffect(
        Effect.gen(function* () {
          const db = yield* DatabaseService;
          const rows = yield* db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", id);
          return rows[0];
        }),
      );

      log("debug", "User", user ? "User found" : "User not found", {
        userId: id,
        userExists: !!user,
        email: user?.email,
        authProvider: user?.authProvider,
      });

      return user;
    },
    { userId: id },
  );
}

export async function getUserByExternalId(externalId: User["externalId"]) {
  return trackPerformance(
    "getUserByExternalId",
    async () => {
      log("debug", "User", "Fetching user by external ID", { externalId });

      const user = await runEffect(
        Effect.gen(function* () {
          const db = yield* DatabaseService;
          const rows = yield* db
            .selectFrom("users")
            .selectAll()
            .where("externalId", "=", externalId);
          return rows[0];
        }),
      );

      log(
        "debug",
        "User",
        user ? "User found by external ID" : "User not found by external ID",
        {
          externalId,
          userExists: !!user,
          userId: user?.id,
          email: user?.email,
          authProvider: user?.authProvider,
        },
      );

      return user;
    },
    { externalId },
  );
}

export async function getUserByEmail(email: User["email"]) {
  return trackPerformance(
    "getUserByEmail",
    async () => {
      log("debug", "User", "Fetching user by email", { email });

      const user = await runEffect(
        Effect.gen(function* () {
          const db = yield* DatabaseService;
          const rows = yield* db
            .selectFrom("users")
            .selectAll()
            .where("email", "=", email);
          return rows[0];
        }),
      );

      log(
        "debug",
        "User",
        user ? "User found by email" : "User not found by email",
        {
          email,
          userExists: !!user,
          userId: user?.id,
          authProvider: user?.authProvider,
        },
      );

      return user;
    },
    { email },
  );
}

export async function createUser(
  email: User["email"],
  externalId: User["externalId"],
) {
  return trackPerformance(
    "createUser",
    async () => {
      log("info", "User", "Creating new user", {
        email,
        externalId,
        authProvider: "discord",
      });

      const out = await runEffect(
        Effect.gen(function* () {
          const db = yield* DatabaseService;
          const rows = yield* db
            .insertInto("users")
            .values([
              {
                id: randomUUID(),
                email,
                externalId,
                authProvider: "discord",
              },
            ])
            .returningAll();
          if (rows[0] === undefined)
            return yield* Effect.fail(
              new NotFoundError({ resource: "db record", id: "" }),
            );
          return rows[0];
        }),
      );

      log("info", "User", "User created successfully", {
        userId: out.id,
        email: out.email,
        externalId: out.externalId,
        authProvider: out.authProvider,
      });

      return out.id;
    },
    { email, externalId },
  );
}

export async function deleteUserByEmail(email: User["email"]) {
  return runEffect(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      return yield* db.deleteFrom("users").where("email", "=", email);
    }),
  );
}
