import { runEffect } from "#~/AppRuntime";
import { DiscordClient } from "#~/discord/client.server";
import { buildVersionPayload } from "#~/helpers/version.server";

// Public diagnostics. Must answer fast even with the gateway down, so we only
// read the already-constructed client (never await readiness) and fall back to
// "not ready" if the runtime can't hand it over promptly.
export async function loader() {
  const client = await Promise.race([
    runEffect(DiscordClient).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
  return Response.json(buildVersionPayload(client), {
    headers: { "Cache-Control": "no-store" },
  });
}
