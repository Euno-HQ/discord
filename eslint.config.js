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
    // Local ESLint rule modules are plain-JS tooling (untyped AST callbacks),
    // not app code — type-aware lint rules produce false positives here. This
    // must come last so it overrides the global type-checked rule block above.
    files: ["eslint-rules/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
];
