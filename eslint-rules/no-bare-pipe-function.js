/**
 * @fileoverview Flag bare function expressions passed to `.pipe(...)`.
 * Effect's method-style `x.pipe(f, g)` is plain function application —
 * `g(f(x))` — so a literal arrow/function argument that ignores its parameter
 * silently REPLACES the piped effect instead of chaining onto it:
 *
 *   logEffect("error", ...).pipe(() => interactionReply(...))
 *   //                            ^ the log effect is built, discarded, and
 *   //                              never executed (real HIGH-severity bug)
 *
 * The correct forms go through a combinator, which is a *call expression*
 * that returns a function: `.pipe(Effect.zipRight(other))`,
 * `.pipe(Effect.flatMap((x) => ...))`, `.pipe(Stream.filter(g))`, etc.
 * Those are fine and not flagged. Standalone `pipe(a, f)` (the imported
 * function from "effect") is also not the target — only method-style
 * `.pipe(...)` receivers.
 *
 * Purely syntactic; no type info.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow bare arrow/function expressions as `.pipe(...)` arguments; use an Effect combinator (zipRight/flatMap/tap/...) instead",
    },
    schema: [],
    messages: {
      noBareFunction:
        "`.pipe(fn)` applies fn to the piped value — a bare function here replaces the effect instead of chaining it. Wrap it in a combinator like Effect.zipRight/Effect.flatMap.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "pipe"
        ) {
          return;
        }
        for (const arg of node.arguments) {
          if (
            arg.type === "ArrowFunctionExpression" ||
            arg.type === "FunctionExpression"
          ) {
            context.report({ node: arg, messageId: "noBareFunction" });
          }
        }
      },
    };
  },
};

export default rule;
