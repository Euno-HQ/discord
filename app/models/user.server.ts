import { randomUUID } from "crypto";
import { Context, Effect, Layer } from "effect";
import type { Selectable } from "kysely";

import { DatabaseService, type DB, type SqlError } from "#~/Database";
import { NotFoundError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";

export type User = DB["users"];

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
