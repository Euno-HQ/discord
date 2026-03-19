import { Effect } from "effect";

import { db, run, runTakeFirst, runTakeFirstOrThrow } from "#~/AppRuntime";
import { DatabaseService, type DB } from "#~/Database";
import { NotFoundError } from "#~/effects/errors.ts";
import { log, trackPerformance } from "#~/helpers/observability";

export type Guild = DB["guilds"];

export const SETTINGS = {
  modLog: "modLog",
  moderator: "moderator",
  restricted: "restricted",
  quorum: "quorum",
  deletionLog: "deletionLog",
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
}

export const fetchGuild = async (guildId: string) => {
  return trackPerformance(
    "fetchGuild",
    async () => {
      log("debug", "Guild", "Fetching guild", { guildId });

      const guild = await runTakeFirst(
        db.selectFrom("guilds").selectAll().where("id", "=", guildId),
      );

      log("debug", "Guild", guild ? "Guild found" : "Guild not found", {
        guildId,
        guildExists: !!guild,
        hasSettings: !!guild?.settings,
      });

      return guild;
    },
    { guildId },
  );
};

export const registerGuild = async (guildId: string) => {
  return trackPerformance(
    "registerGuild",
    async () => {
      log("info", "Guild", "Registering guild", { guildId });

      await run(
        db
          .insertInto("guilds")
          .values({
            id: guildId,
            settings: JSON.stringify({}),
          })
          .onConflict((oc) => oc.column("id").doNothing()),
      );

      log("info", "Guild", "Guild registered successfully", { guildId });
    },
    { guildId },
  );
};

export const setSettings = async (
  guildId: string,
  settings: SettingsRecord,
) => {
  await run(
    db
      .updateTable("guilds")
      .set("settings", (eb) =>
        eb.fn("json_patch", ["settings", eb.val(JSON.stringify(settings))]),
      )
      .where("id", "=", guildId),
  );
};

export const fetchSettings = async <T extends keyof typeof SETTINGS>(
  guildId: string,
  keys: T[],
) => {
  const result = Object.entries(
    await runTakeFirstOrThrow(
      db
        .selectFrom("guilds")
        // @ts-expect-error This is broken because of a migration from knex and
        // old/bad use of jsonb for storing settings. The type is guaranteed here
        // not by the codegen
        .select<DB, "guilds", SettingsRecord>((eb) =>
          keys.map((k) => eb.ref("settings", "->>").key(k).as(k)),
        )
        .where("id", "=", guildId),
      // This cast is also evidence of the pattern being broken
    ),
  ) as [T, string][];
  return Object.fromEntries(result) as Pick<SettingsRecord, T>;
};

export const fetchSettingsEffect = <T extends keyof typeof SETTINGS>(
  guildId: string,
  keys: T[],
) =>
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
    Effect.withSpan("fetchSettingsEffect", {
      attributes: { guildId, keys: keys.join(",") },
    }),
  );
