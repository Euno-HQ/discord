import { RuleTester } from "eslint";

import tsParser from "@typescript-eslint/parser";

import rule from "./no-effect-promise.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-effect-promise", rule, {
  valid: [
    // Effect.tryPromise with a tagged error is the whole point.
    `Effect.tryPromise({ try: () => fetch(url), catch: (cause) => new OAuthFetchError({ operation: "fetch", cause }) });`,
    // Bare tryPromise (UnknownException channel) is still typed, not a defect.
    `Effect.tryPromise(() => client.shutdown());`,
    // tryDiscord is the sanctioned wrapper for Discord calls.
    `tryDiscord("fetchGuild", () => client.guilds.fetch(guildId));`,
    // A `promise` method on anything other than Effect is fine.
    `somethingElse.promise(() => doWork());`,
    `deferred.promise();`,
    // Other Effect members are untouched.
    `Effect.succeed(null);`,
    `Effect.gen(function* () { yield* Effect.sync(() => 1); });`,
  ],
  invalid: [
    // Bare arrow returning a promise.
    {
      code: `Effect.promise(() => fetch(url));`,
      errors: [{ messageId: "noEffectPromise" }],
    },
    // Async-function thunk — the other shape the repo has seen.
    {
      code: `Effect.promise(async () => { await new Promise((r) => setTimeout(r, 10)); return "ok"; });`,
      errors: [{ messageId: "noEffectPromise" }],
    },
    // Inside Effect.gen / yield* position.
    {
      code: `Effect.gen(function* () { yield* Effect.promise(() => client.shutdown()); });`,
      errors: [{ messageId: "noEffectPromise" }],
    },
    // As a returned expression from a helper.
    {
      code: `const fetchFlags = (id) => Effect.promise(() => posthog.getAllFlags(id));`,
      errors: [{ messageId: "noEffectPromise" }],
    },
  ],
});
