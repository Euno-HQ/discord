import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { defineConfig, getKnexTimestampPrefix } from "kysely-ctl";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL === "DATABASE_URL") {
  throw new Error(
    "Please provide a DATABASE_URL! an absolute path to mod-bot.sqlite3",
  );
}

const dialect = new SqliteDialect({
  database: new SQLite(process.env.DATABASE_URL),
});

export default defineConfig({
  dialect,
  migrations: {
    getMigrationPrefix: getKnexTimestampPrefix,
  },
});
