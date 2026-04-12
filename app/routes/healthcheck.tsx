// learn more: https://fly.io/docs/reference/configuration/#services-http_checks
import { Effect } from "effect";

import { SqlClient } from "@effect/sql";

import { runEffect } from "#~/AppRuntime";

import type { Route } from "./+types/healthcheck";

export async function loader({ request }: Route.LoaderArgs) {
  const host =
    request.headers.get("X-Forwarded-Host") ?? request.headers.get("host");

  try {
    const url = new URL("/", `http://${host}`);
    // if we can connect to the database and make a simple query
    // and make a HEAD request to ourselves, then we're good.
    await Promise.all([
      runEffect(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          );
        }),
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
