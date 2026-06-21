import { randomUUID } from "crypto";
import { Context, Effect, Layer } from "effect";
import type { Selectable } from "kysely";

import { db, run, runTakeFirst, runTakeFirstOrThrow } from "#~/AppRuntime";
import { DatabaseService, type DB, type SqlError } from "#~/Database";
import { NotFoundError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { log, trackPerformance } from "#~/helpers/observability";

export type User = DB["users"];

export async function getUserById(id: User["id"]) {
  return trackPerformance(
    "getUserById",
    async () => {
      log("debug", "User", "Fetching user by ID", { userId: id });

      const user = await runTakeFirst(
        db.selectFrom("users").selectAll().where("id", "=", id),
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

      const user = await runTakeFirst(
        db.selectFrom("users").selectAll().where("externalId", "=", externalId),
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

      const user = await runTakeFirst(
        db.selectFrom("users").selectAll().where("email", "=", email),
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

      const out = await runTakeFirstOrThrow(
        db
          .insertInto("users")
          .values([
            {
              id: randomUUID(),
              email,
              externalId,
              authProvider: "discord",
            },
          ])
          .returningAll(),
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
  return run(db.deleteFrom("users").where("email", "=", email));
}

export interface IUserService {
  readonly getUserById: (
    id: string,
  ) => Effect.Effect<Selectable<DB["users"]> | undefined, SqlError>;
  readonly getUserByExternalId: (
    externalId: string,
  ) => Effect.Effect<Selectable<DB["users"]> | undefined, SqlError>;
  readonly getUserByEmail: (
    email: string | null,
  ) => Effect.Effect<Selectable<DB["users"]> | undefined, SqlError>;
  readonly createUser: (
    email: string | null,
    externalId: string,
  ) => Effect.Effect<string, SqlError | NotFoundError>;
  readonly deleteUserByEmail: (
    email: string | null,
  ) => Effect.Effect<void, SqlError>;
}

export class UserService extends Context.Tag("UserService")<
  UserService,
  IUserService
>() {}

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    return {
      getUserById: (id) =>
        Effect.gen(function* () {
          yield* logEffect("debug", "UserService", "Fetching user by ID", {
            userId: id,
          });
          const [user] = yield* db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", id);
          yield* logEffect(
            "debug",
            "UserService",
            user ? "User found" : "User not found",
            { userId: id, userExists: !!user },
          );
          return user;
        }).pipe(
          Effect.withSpan("UserService.getUserById", {
            attributes: { userId: id },
          }),
        ),

      getUserByExternalId: (externalId) =>
        Effect.gen(function* () {
          yield* logEffect(
            "debug",
            "UserService",
            "Fetching user by external ID",
            { externalId },
          );
          const [user] = yield* db
            .selectFrom("users")
            .selectAll()
            .where("externalId", "=", externalId);
          return user;
        }).pipe(
          Effect.withSpan("UserService.getUserByExternalId", {
            attributes: { externalId },
          }),
        ),

      getUserByEmail: (email) =>
        Effect.gen(function* () {
          const [user] = yield* db
            .selectFrom("users")
            .selectAll()
            .where("email", "=", email);
          return user;
        }).pipe(Effect.withSpan("UserService.getUserByEmail")),

      createUser: (email, externalId) =>
        Effect.gen(function* () {
          yield* logEffect("info", "UserService", "Creating new user", {
            email,
            externalId,
            authProvider: "discord",
          });
          const [row] = yield* db
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
          if (!row) {
            return yield* Effect.fail(
              new NotFoundError({ resource: "user", id: externalId }),
            );
          }
          yield* logEffect("info", "UserService", "User created successfully", {
            userId: row.id,
            email: row.email,
            externalId: row.externalId,
            authProvider: row.authProvider,
          });
          return row.id;
        }).pipe(
          Effect.withSpan("UserService.createUser", {
            attributes: { externalId },
          }),
        ),

      deleteUserByEmail: (email) =>
        Effect.gen(function* () {
          yield* db.deleteFrom("users").where("email", "=", email);
        }).pipe(Effect.withSpan("UserService.deleteUserByEmail")),
    };
  }),
);
