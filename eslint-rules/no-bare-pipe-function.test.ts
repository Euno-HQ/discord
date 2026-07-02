import { RuleTester } from "eslint";

import tsParser from "@typescript-eslint/parser";

import rule from "./no-bare-pipe-function.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-bare-pipe-function", rule, {
  valid: [
    // Combinator call expressions return functions — the idiomatic form.
    `effect.pipe(Effect.map((x) => x));`,
    `logEffect("error", "Svc", "failed").pipe(Effect.zipRight(interactionReply(interaction, "oops")));`,
    // Chained combinator arguments, including arrows *inside* combinators.
    `effect.pipe(
      Effect.tap((r) => logEffect("info", "Svc", "done", { r })),
      Effect.catchAll((e) => Effect.succeed(e)),
      Effect.flatMap((x) => other(x)),
    );`,
    `stream.pipe(Stream.filter((m) => m.guildId != null), Stream.mapEffect(handle));`,
    // Standalone `pipe(a, f)` imported from "effect" IS function application
    // by design — bare functions there are correct, never flagged.
    `pipe(value, (v) => v + 1);`,
    `pipe(effect, Effect.map((x) => x), (self) => Effect.timeout(self, "5 seconds"));`,
    // A pipe *property* that isn't called with a bare fn.
    `effect.pipe();`,
  ],
  invalid: [
    // The real bug shape: the error log was constructed, discarded, and never
    // executed because `.pipe(f)` is just `f(log)`.
    {
      code: `logEffect("error", "Svc", "failed", { error }).pipe(() => interactionReply(interaction, "oops"));`,
      errors: [{ messageId: "noBareFunction" }],
    },
    // Function-expression variant.
    {
      code: `effect.pipe(function (self) { return other; });`,
      errors: [{ messageId: "noBareFunction" }],
    },
    // Async arrow variant.
    {
      code: `effect.pipe(async () => otherEffect);`,
      errors: [{ messageId: "noBareFunction" }],
    },
    // Bare arrow mixed in among legitimate combinators — only it is flagged.
    {
      code: `effect.pipe(Effect.map((x) => x), () => replacement);`,
      errors: [{ messageId: "noBareFunction" }],
    },
  ],
});
