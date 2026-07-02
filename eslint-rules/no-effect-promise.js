/**
 * @fileoverview Forbid `Effect.promise(...)`. It asserts the promise can never
 * reject; when one does anyway, the rejection becomes a *defect* — it bypasses
 * the typed error channel and sails past every `Effect.catchAll`, which in this
 * codebase has killed daemon pipeline fibers. Integrate promises with
 * `Effect.tryPromise` and a tagged error instead (`tryDiscord` for Discord
 * calls); see notes/EFFECT.md "Promise Integration".
 *
 * For a genuinely-never-rejecting promise, an eslint-disable comment with a
 * one-line justification is the sanctioned escape hatch.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect.promise; rejections become defects that bypass typed error handling — use Effect.tryPromise with a tagged error",
    },
    schema: [],
    messages: {
      noEffectPromise:
        "Effect.promise turns rejections into defects that bypass every Effect.catchAll (this has killed daemon pipeline fibers). Use Effect.tryPromise with a tagged error (or tryDiscord for Discord calls); if the promise truly never rejects, eslint-disable with a justification.",
    },
  },
  create(context) {
    return {
      // Effect.promise(...) — the direct member call, which is the only shape
      // this codebase uses (`import { Effect } from "effect"`).
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Effect" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "promise"
        ) {
          context.report({ node, messageId: "noEffectPromise" });
        }
      },
    };
  },
};

export default rule;
