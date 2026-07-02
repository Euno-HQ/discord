// learn more: https://fly.io/docs/reference/configuration/#services-http_checks
import { runEffect } from "#~/AppRuntime";
import { probeDatabase } from "#~/models/healthcheck.server";

import type { Route } from "./+types/healthcheck";

export async function loader({ request }: Route.LoaderArgs) {
  const host =
    request.headers.get("X-Forwarded-Host") ?? request.headers.get("host");

  try {
    const url = new URL("/", `http://${host}`);
    // if we can connect to the database and make a simple query
    // and make a HEAD request to ourselves, then we're good.
    await Promise.all([
      runEffect(probeDatabase()),
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
