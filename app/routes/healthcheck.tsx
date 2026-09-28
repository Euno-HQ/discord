// learn more: https://fly.io/docs/reference/configuration/#services-http_checks
import { runEffect } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";

import type { Route } from "./+types/healthcheck";

export async function loader({ request }: Route.LoaderArgs) {
  const host =
    request.headers.get("X-Forwarded-Host") ?? request.headers.get("host");

  try {
    const url = new URL("/", `http://${host}`);
    // if we can connect to the database and make a simple query
    // and make a HEAD request to ourselves, then we're good.
    await Promise.all([
      // Resolve the live DB handle from the runtime, then run the query
      // builder (itself an Effect<rows, SqlError>). No `effect` import — this
      // route module is client-reachable.
      runEffect(DatabaseService).then((db) =>
        runEffect(
          db
            // @ts-expect-error because kysely doesn't generate types for sqlite_master
            .selectFrom("sqlite_master")
            // @ts-expect-error because kysely doesn't generate types for sqlite_master
            .select("name")
            .where("type", "=", "table"),
        ),
      ),
      fetch(url.toString(), { method: "HEAD" }).then((r) => {
        if (!r.ok) {
          return Promise.reject(
            new Error(`${r.status} ${r.statusText} ${r.url}`),
          );
        }
      }),
    ]);
    return new Response("OK");
  } catch (error: unknown) {
    console.log("healthcheck ❌", { error });
    return new Response("ERROR", { status: 500 });
  }
}
