/**
 * @fileoverview Flag stringifying typed Effect errors. `Data.TaggedError`
 * instances have a custom `toString()` that returns only the `_tag` (e.g.
 * `"DiscordApiError"`), so `String(error)` / `${error}` silently drops the
 * `cause` chain and every structured field. `@typescript-eslint/no-base-to-string`
 * does NOT catch this (the custom toString isn't "base"), hence this rule.
 *
 * The fix is always to pass the error through directly — `logEffect` runs it
 * through Effect's JSON logger, which serializes `_tag` and the tagged fields.
 *
 */

// Identifiers conventionally bound to errors in this codebase.
const ERROR_NAMES = new Set(["error", "err", "e", "cause"]);

// Effect error-channel handlers whose first arrow param is the error/cause,
// even when named something other than the conventional names above.
const CATCH_METHODS = new Set([
  "catchAll",
  "catchAllCause",
  "catchTag",
  "catchTags",
]);

/** Is this arrow the handler argument of `X.catchAll(...)` / `X.catchTag(...)` etc.? */
function isCatchHandler(arrow) {
  const call = arrow.parent;
  return (
    call?.type === "CallExpression" &&
    call.callee.type === "MemberExpression" &&
    call.callee.property.type === "Identifier" &&
    CATCH_METHODS.has(call.callee.property.name) &&
    call.arguments.includes(arrow)
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow stringifying typed Effect errors; pass them through to logEffect instead",
    },
    schema: [],
    messages: {
      noStringify:
        "Don't stringify errors — pass the tagged error through; logEffect serializes structured payloads.",
    },
  },
  create(context) {
    // Stack of active catch-handler param-name sets, so an error-channel
    // param is recognized even when not named error/err/e/cause.
    const catchParams = [];
    const catchParamActive = (name) => catchParams.some((s) => s.has(name));

    /** Does stringifying this expression destroy an error payload? */
    const isErrorish = (node) => {
      if (node.type === "Identifier") {
        return ERROR_NAMES.has(node.name) || catchParamActive(node.name);
      }
      // `x.cause` — stringifying a cause is always lossy, whatever `x` is named.
      return (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "cause"
      );
    };

    return {
      ArrowFunctionExpression(node) {
        if (isCatchHandler(node)) {
          catchParams.push(
            new Set(
              node.params
                .filter((p) => p.type === "Identifier")
                .map((p) => p.name),
            ),
          );
        }
      },
      "ArrowFunctionExpression:exit"(node) {
        if (isCatchHandler(node)) catchParams.pop();
      },
      // String(error) — and only the global String, not a shadowed local.
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "String" &&
          node.arguments.length === 1 &&
          isErrorish(node.arguments[0])
        ) {
          context.report({ node, messageId: "noStringify" });
        }
      },
      // `${error}` in a template literal expression position.
      TemplateLiteral(node) {
        for (const expr of node.expressions) {
          if (isErrorish(expr)) {
            context.report({ node: expr, messageId: "noStringify" });
          }
        }
      },
    };
  },
};

export default rule;
