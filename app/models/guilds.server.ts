import { Effect } from "effect";
import type { Selectable } from "kysely";

import { DatabaseService, type DB, type SqlError } from "#~/Database";
import { NotFoundError } from "#~/effects/errors.ts";
import { logEffect } from "#~/effects/observability";

export type Guild = DB["guilds"];

export const SETTINGS = {
  modLog: "modLog",
  moderator: "moderator",
  restricted: "restricted",
  quorum: "quorum",
  deletionLog: "deletionLog",
  memberRole: "memberRole",
  applicationChannel: "applicationChannel",
} as const;

export const DEFAULT_QUORUM = 3;

// These types are not enforced by the database, they need to be carefully
// managed by setup guarantees
interface SettingsRecord {
  [SETTINGS.modLog]: string;
  [SETTINGS.moderator]: string;
  [SETTINGS.restricted]?: string;
  [SETTINGS.quorum]?: number;
  [SETTINGS.deletionLog]?: string;
  [SETTINGS.memberRole]?: string;
  [SETTINGS.applicationChannel]?: string;
}

// --- Free Effect functions ---
// Each requires DatabaseService in context (provided by AppLayer / test layers).
// Effect callers:    yield* fetchSettings(...)
// Web-async callers: await runEffect(setSettings(...))

export const fetchGuild = (
  guildId: string,
): Effect.Effect<
  Selectable<DB["guilds"]> | undefined,
  SqlError,
  DatabaseService
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect("debug", "Guild", "Fetching guild", { guildId });

    const rows = yield* db
      .selectFrom("guilds")
      .selectAll()
      .where("id", "=", guildId);
    const guild = rows[0];

    yield* logEffect(
      "debug",
      "Guild",
      guild ? "Guild found" : "Guild not found",
      {
        guildId,
        guildExists: !!guild,
        hasSettings: !!guild?.settings,
      },
    );

    return guild;
  }).pipe(Effect.withSpan("Guild.fetchGuild", { attributes: { guildId } }));

export const registerGuild = (
  guildId: string,
): Effect.Effect<void, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect("info", "Guild", "Registering guild", { guildId });

    yield* db
      .insertInto("guilds")
      .values({
        id: guildId,
        settings: JSON.stringify({}),
      })
      .onConflict((oc) => oc.column("id").doNothing());

    yield* logEffect("info", "Guild", "Guild registered successfully", {
      guildId,
    });
  }).pipe(Effect.withSpan("Guild.registerGuild", { attributes: { guildId } }));

export const setSettings = (
  guildId: string,
  settings: SettingsRecord,
): Effect.Effect<void, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    // PRESERVE VERBATIM (#335 NULL-coalesce fix): merge new settings into the
    // existing JSON, treating a NULL settings column as an empty object.
    yield* db
      .updateTable("guilds")
      .set("settings", (eb) =>
        eb.fn("json_patch", [
          eb.fn("coalesce", ["settings", eb.val("{}")]),
          eb.val(JSON.stringify(settings)),
        ]),
      )
      .where("id", "=", guildId);
  }).pipe(Effect.withSpan("Guild.setSettings", { attributes: { guildId } }));

export const deleteGuild = (
  guildId: string,
): Effect.Effect<void, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* db.deleteFrom("guilds").where("id", "=", guildId);
  }).pipe(Effect.withSpan("Guild.deleteGuild", { attributes: { guildId } }));

export const fetchSettings = <T extends keyof typeof SETTINGS>(
  guildId: string,
  keys: T[],
): Effect.Effect<
  Pick<SettingsRecord, T>,
  SqlError | NotFoundError,
  DatabaseService
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const rows = yield* db
      .selectFrom("guilds")
      // @ts-expect-error This is broken because of a migration from knex and
      // old/bad use of jsonb for storing settings. The type is guaranteed here
      // not by the codegen
      .select<DB, "guilds", SettingsRecord>((eb) =>
        keys.map((k) => eb.ref("settings", "->>").key(k).as(k)),
      )
      .where("id", "=", guildId);
    const result = Object.entries(rows[0] ?? {}) as [T, string][];
    if (result.length === 0) {
      return yield* Effect.fail(
        new NotFoundError({ id: guildId, resource: "guild" }),
      );
    }
    return Object.fromEntries(result) as Pick<SettingsRecord, T>;
  }).pipe(
    Effect.withSpan("Guild.fetchSettings", {
      attributes: { guildId, keys: keys.join(",") },
    }),
  );

/**
 * Recovered variant of fetchSettings for callers that treat missing settings
 * as "not configured yet." First-time-setup guilds legitimately have no
 * settings row, so NotFoundError recovers silently; any other failure (a
 * broken DB) is logged and also recovers, so the two stay distinguishable in
 * the logs.
 */
export const fetchSettingsOrUndefined = <T extends keyof typeof SETTINGS>(
  guildId: string,
  keys: T[],
): Effect.Effect<Pick<SettingsRecord, T> | undefined, never, DatabaseService> =>
  fetchSettings(guildId, keys).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
    Effect.catchAll((error) =>
      logEffect("error", "Guild", "Failed to fetch settings", {
        guildId,
        error,
      }).pipe(Effect.as(undefined)),
    ),
    Effect.withSpan("Guild.fetchSettingsOrUndefined", {
      attributes: { guildId, keys: keys.join(",") },
    }),
  );
