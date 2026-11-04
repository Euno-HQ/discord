import { Client } from "discord.js";

import { BotREST } from "./botRest.server";

test("the shared REST keeps its token when the gateway client is destroyed", async () => {
  const makeRequest = vi.fn(
    async () =>
      new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  const rest = new BotREST({
    version: "10",
    // DOM vs undici Response typings; the runtime shape is what REST reads.
    makeRequest: makeRequest as never,
  }).setToken("t");
  const client = new Client({ intents: [] });
  client.rest = rest;

  // What client.login() does after every failed attempt.
  await client.destroy();

  await expect(rest.get("/users/@me")).resolves.toEqual({});
  expect(makeRequest).toHaveBeenCalledOnce();
});
