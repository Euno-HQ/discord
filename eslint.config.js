import globals from "globals";
import tseslint from "typescript-eslint";

import { FlatCompat } from "@eslint/eslintrc";
import pluginJs from "@eslint/js";

import noErrorStringCast from "./eslint-rules/no-error-string-cast.js";

const compat = new FlatCompat();

// Local rules for codebase conventions the shared plugins can't know about.
const localPlugin = {
  rules: { "no-error-string-cast": noErrorStringCast },
};

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  { files: ["app/**/*.{js,mjs,cjs,ts,jsx,tsx}"] },
  {
    ignores: [
      ".lintstagedrc.js",
      "build",
      "migrations",
      // # Hack fix to override default behavior for ignore files linted by name
      // # https://github.com/eslint/eslint/issues/15010
      "!.*",
      "node_modules",
      "public",
      ".react-router",
      "*timestamp*",
      ".claude",
    ],
  },
  {
    settings: {
      react: { version: "detect" },
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...compat.extends("plugin:react-hooks/recommended"),
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            ".lintstagedrc.js",
            "eslint.config.js",
            "postcss.config.mjs",
            "tailwind.config.js",
            "scripts/get-stripe-price.js",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Config files don't need type-checked linting
    files: [
      "*.config.{js,mjs,ts}",
      ".lintstagedrc.js",
      "eslint.config.js",
      "index.*.js",
    ],
  },
  {
    plugins: { local: localPlugin },
    rules: {
      // General JavaScript rules
      "no-debugger": "warn",
      "prefer-const": "error",
      "no-var": "error",

      // Two ways an Effect signature can lie about how a program fails. Both are
      // at zero repo-wide with no suppressions; keep them there.
      "no-restricted-syntax": [
        "warn",
        {
          // `Effect.promise` asserts in the TYPE that a promise cannot reject.
          // When one does, the rejection is a DEFECT: absent from the error
          // channel, it kills the fiber and surfaces as an opaque FiberFailure —
          // a program breaking in a way its signature never admitted was
          // possible. It cost a real safety net once already: fetchAuditLogEntry
          // looked infallible, so a catchAll guarding it was deleted as dead code.
          selector:
            "MemberExpression[object.name='Effect'][property.name='promise']",
          message:
            "Effect.promise hides a rejection as a defect. Use Effect.tryPromise with a typed catch (tryDiscord for Discord calls).",
        },
        {
          // The bare `Effect.tryPromise(() => …)` form says "this can fail" but
          // not HOW: the failure becomes UnknownException, so callers can't
          // discriminate it and toUserResponse can only give it generic copy.
          //
          // This rule exists because `check:effect` structurally CANNOT see it —
          // `unknownInEffectCatch` only fires on the `{ try, catch }` shape. 13
          // of these sat invisible behind a green gate until the debt ratchet
          // counted them, and the AST rule then found 11 more that the ratchet's
          // regex had missed. Between the two rules both shapes are now covered.
          //
          // Match on the argument being a FUNCTION, not merely on argument count:
          // the correct `Effect.tryPromise({ try, catch })` form is also a single
          // argument, so an arguments.length check would forbid the fix as well
          // as the defect.
          selector:
            "CallExpression[callee.object.name='Effect'][callee.property.name='tryPromise'] > :matches(ArrowFunctionExpression, FunctionExpression)",
          message:
            "Single-arg Effect.tryPromise erases the failure into UnknownException. Pass { try, catch } with a tagged error (or use tryDiscord for Discord calls).",
        },
      ],

      // React rules
      "react/react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "warn",

      // TypeScript rules
      "@typescript-eslint/ban-ts-comment": [
        "warn",
        { "ts-ignore": "allow-with-description" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: { attributes: false, arguments: false },
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/only-throw-error": "off", // React Router uses throw redirect()

      // Allow common patterns
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",

      // Errors are tagged (Data.TaggedError) — stringifying them collapses the
      // _tag discriminant, cause chain, and structured fields into "[object
      // Object]" or a useless top-line. Pass the typed error through to
      // logEffect, which serializes the structured payload. See issue #366 and
      // the no-error-string-cast rule below.
      "@typescript-eslint/no-base-to-string": "error",

      // Pass typed Effect errors through to logEffect instead of stringifying
      // them — String(taggedError) collapses to just the _tag. See issue #366.
      "local/no-error-string-cast": "warn",

      "no-console": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // These three run in async/await + discord.js event zones, not Effect: the
    // caught value is `unknown` from a try/catch or Promise `.catch`, not a
    // typed tagged error, and they use the legacy `log` helper. The
    // instanceof-Error pattern here is a separate concern (see issue #366
    // "Out of scope"); a future async-zone rule should cover them.
    files: [
      "app/discord/api.ts",
      "app/discord/client.server.ts",
      "app/discord/gateway.ts",
    ],
    rules: { "local/no-error-string-cast": "off" },
  },
  {
    // Effect must never reach the client bundle. It lives in *.server.ts modules
    // (RRv7+Vite strips those from the client build) or in confirmed server-only
    // directories that the client graph never imports. Client-reachable code
    // (routes' component parts, components, root, entry.client) must reach Effect
    // only through route loaders/actions — never by importing `effect` directly.
    //
    // This block forbids `effect`/`effect/*`/`@effect/*` imports across all app
    // source, then carves out the server zone via `ignores`. The CI bundle check
    // (npm run check:client-bundle) is the authoritative net; this rule is fast
    // local feedback. See notes/EFFECT.md.
    files: ["app/**/*.{ts,tsx}"],
    ignores: [
      // RRv7 hard guarantee: *.server.{ts,tsx} are stripped from the client build.
      "**/*.server.ts",
      "**/*.server.tsx",
      // Server entrypoints / runtime wiring (never in the client graph).
      "app/server.ts",
      "app/entry.server.tsx",
      "app/AppRuntime.ts",
      "app/Database.ts",
      // Entirely server-only directories (Discord bot, command handlers, Effect
      // services, background jobs, persistence models — none client-reachable).
      "app/effects/**",
      "app/discord/**",
      "app/commands/**",
      "app/jobs/**",
      "app/models/**",
      // Mixed directories (app/helpers, app/features contain both client and
      // server files): narrow per-file exceptions for confirmed server-only
      // modules that lack a .server.ts suffix. These are not imported by any
      // client-reachable module today; ideally they'd be renamed to *.server.ts.
      "app/helpers/discord.ts",
      "app/features/spam/service.ts",
      "app/features/spam/spamResponseHandler.ts",
      "app/features/spam/velocityGate.ts",
      // Tests are not part of any shipped bundle.
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "effect",
              message:
                "Effect must not reach the client bundle. Move Effect code into a *.server.ts module (or a confirmed server-only dir) and have client code reach it through a route loader/action. See notes/EFFECT.md.",
            },
          ],
          patterns: [
            {
              group: ["effect/*", "@effect/*"],
              message:
                "Effect must not reach the client bundle. Move Effect code into a *.server.ts module (or a confirmed server-only dir) and have client code reach it through a route loader/action. See notes/EFFECT.md.",
            },
          ],
        },
      ],
    },
  },
  {
    // The Effect.promise ban targets PRODUCTION defects — a rejection that no
    // signature admitted was possible. In a test, `Effect.promise(() =>
    // Promise.reject(...))` is often the point: it deliberately constructs a
    // defect to assert the code under test survives one. Allowed here.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Local ESLint rule modules are plain-JS tooling (untyped AST callbacks),
    // not app code — type-aware lint rules produce false positives here. This
    // must come last so it overrides the global type-checked rule block above.
    files: ["eslint-rules/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
];
