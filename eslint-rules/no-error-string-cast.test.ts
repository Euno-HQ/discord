import { RuleTester } from "eslint";

import tsParser from "@typescript-eslint/parser";

import rule from "./no-error-string-cast.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-error-string-cast", rule, {
  valid: [
    // Passing the error through directly is the whole point.
    `logEffect("error", "Svc", "failed", { error });`,
    `logEffect("error", "Svc", "failed", { error: err });`,
    // Non-error values may legitimately be stringified.
    `const limit = String(batchSize);`,
    `const perms = String(memberPerms | PermissionFlagsBits.ViewChannel);`,
    `const month = String(row.month);`,
    `const stamp = String(d.getMonth() + 1);`,
    // Template literals over non-error values are fine.
    "const msg = `count: ${count}`;",
    // Member access that isn't `.cause` is fine.
    `const s = String(error.message);`,
    // An identifier merely named like an error but not stringified is fine.
    `const guild = e.guild;`,
  ],
  invalid: [
    // Bare error-named identifiers.
    {
      code: `const s = String(error);`,
      errors: [{ messageId: "noStringify" }],
    },
    {
      code: `const s = String(err);`,
      errors: [{ messageId: "noStringify" }],
    },
    {
      code: `const s = String(e);`,
      errors: [{ messageId: "noStringify" }],
    },
    // Inside a logEffect context object.
    {
      code: `logEffect("error", "Svc", "failed", { error: String(error) });`,
      errors: [{ messageId: "noStringify" }],
    },
    // `.cause` member access is always wrong to stringify, regardless of the
    // object's name (covers Effect Exit causes like `String(exit.cause)`).
    {
      code: `const s = String(error.cause);`,
      errors: [{ messageId: "noStringify" }],
    },
    {
      code: `const s = String(exit.cause);`,
      errors: [{ messageId: "noStringify" }],
    },
    // Error identifiers in template-literal expression positions.
    {
      code: "const s = `boom: ${error}`;",
      errors: [{ messageId: "noStringify" }],
    },
    {
      code: "yield* failJobEffect(job.id, `Unhandled: ${String(err)}`);",
      errors: [{ messageId: "noStringify" }],
    },
    // new Error(String(error)) — the inner cast is flagged.
    {
      code: `const wrapped = new Error(String(error));`,
      errors: [{ messageId: "noStringify" }],
    },
    // catchAll/catchTag/catchAllCause arrow param, even with a non-matching name.
    {
      code: `pipe(self, Effect.catchAll((failure) => String(failure)));`,
      errors: [{ messageId: "noStringify" }],
    },
    {
      code: `pipe(self, Effect.catchTag("X", (boom) => logEffect("error", "S", "m", { error: String(boom) })));`,
      errors: [{ messageId: "noStringify" }],
    },
  ],
});
