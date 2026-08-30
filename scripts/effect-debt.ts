/**
 * Effect migration debt counter — a ratchet, not a report.
 *
 * The problem this exists to solve: "the migration is mostly done" is a belief,
 * and beliefs don't detect drift. Every number below is a distinct way an Effect
 * type can lie about what a program does. Run it and you get a count, not a
 * narrative.
 *
 *   npm run effect:debt          print counts vs. the committed baseline
 *   npm run effect:debt -- --set rewrite the baseline (do this only when a
 *                                number legitimately goes DOWN)
 *
 * Wired into `npm run validate`, so any count going UP fails CI. That is the
 * whole mechanism: you cannot drift without the build telling you.
 *
 * NOTE the `suppressions` metrics. A gate that only counts violations is gamed
 * by silencing them, and that already happened here: 8
 * `@effect-diagnostics-next-line globalErrorInEffectFailure:off` comments landed
 * in setupHandlers.ts in #390, so `check:effect` reports 0 errors while 8 real
 * violations sit suppressed. Counting suppressions closes that loophole.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const BASELINE = "scripts/effect-debt.baseline.json";

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if ([".ts", ".tsx"].includes(extname(e.name))) out.push(p);
  }
  return out;
};

const all = walk("app");
const src = all.filter((f) => !f.includes(".test."));
/**
 * Strip comments before counting. Learned the hard way twice: the first version
 * of `bridgesOutsideRoutes` read 45 when the real number was ~37, because
 * docstrings saying "call this with runEffect(...)" counted as bridges. A metric
 * that counts prose is a metric that lies, which is the one thing this script
 * must not do.
 *
 * Heuristic, not a parser: the `[^:]` guard keeps `https://` intact, but a `//`
 * inside a string literal not preceded by `:` would still be treated as a
 * comment. Good enough for counting debt; if a metric here ever needs to be
 * exact, that is the signal to graduate it to a lint rule instead of sharpening
 * the regex.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const readRaw = (fs: string[]) =>
  fs.map((f) => [f, readFileSync(f, "utf8")] as const);

/** Code-shaped metrics read stripped text; comment-shaped ones must read raw. */
const read = (fs: string[]) =>
  readRaw(fs).map(([f, s]) => [f, stripComments(s)] as const);

const count = (files: readonly (readonly [string, string])[], re: RegExp) =>
  files.reduce((n, [, s]) => n + (s.match(re) ?? []).length, 0);

const S = read(src);
// Suppression counts target the comments THEMSELVES, so they read raw text --
// stripping comments first would silently zero them, which it did on the first
// attempt. Another reminder that a metric can be broken by its own plumbing.
const Araw = readRaw(all);
const Sraw = readRaw(src);

/**
 * Each entry: what it counts, and why that number lying is a real bug.
 *
 * Two kinds of metric, and confusing them wastes effort:
 *
 *   TARGET — can legitimately reach 0, and once it does it should GRADUATE to a
 *     lint rule with no suppressions, at which point the counter is redundant.
 *     `effectPromise` and `bareTryPromise` both did exactly this. Still open:
 *     unknownErrorChannel, anyErrorChannel (both at 0, not yet graduated).
 *
 *   CAP — will never be 0, because some of what it counts is correct. The number
 *     exists to stop it growing, and any increase should be justified in review.
 *     `asyncInServerZones` is the clearest case: 8 of the 13 are the
 *     Response/redirect-throwing auth functions in session.server.ts and api.ts,
 *     which MUST stay async — running one inside Effect wraps the thrown
 *     redirect in a FiberFailure and breaks React Router. Same for
 *     bridgesOutsideRoutes (discord.js event callbacks are a real boundary) and
 *     the escape-hatch counts, where a justified suppression beats a bad cast.
 */
const metrics: Record<string, number> = {
  // A rejection becomes an invisible defect that kills the fiber.
  effectPromise: count(S, /Effect\.promise\(/g),
  // NOTE: `bareTryPromise` used to live here and has been RETIRED, which is the
  // intended end-state for a TARGET metric. It reached 0, graduated to an ESLint
  // rule (`no-restricted-syntax`, matching the AST rather than text), and the
  // counter became both redundant and WRONG: its regex only matched
  // `tryPromise(() =>` on one line, so it read 0 while the AST rule immediately
  // found 11 more in multi-line and `async () =>` forms. Worth remembering when
  // adding a metric here -- a regex approximates the thing you care about, and a
  // green approximation is exactly the false confidence this script exists to
  // prevent. Prefer graduating to a real rule over refining the regex.
  // An explicit `unknown`/`any` error channel widens the real union to nothing.
  unknownErrorChannel: count(S, /Effect\.Effect<[^>]*,\s*unknown,/g),
  anyErrorChannel: count(S, /Effect\.Effect<[^>]*,\s*any,/g),
  // Promise bridges outside route loaders/actions are un-migrated seams.
  bridgesOutsideRoutes:
    count(
      S,
      /runEffect\(|runEffectExit\(|Effect\.runPromise|Effect\.runSync|Effect\.runFork|runtime\.run/g,
    ) -
    count(
      read(src.filter((f) => f.startsWith("app/routes/"))),
      /runEffect\(|runEffectExit\(/g,
    ),
  // Async functions still living in server-only Effect zones.
  asyncInServerZones: count(
    read(
      src.filter((f) =>
        /^app\/(models|commands|jobs|discord|effects)\//.test(f),
      ),
    ),
    /^(export )?(const [a-zA-Z]+ = )?async |async function/gm,
  ),
  // Escape hatches. Each one is a place the compiler stopped proving things.
  asCasts: count(S, /as any|as unknown as/g),
  tsExpectError: count(Sraw, /@ts-expect-error|@ts-ignore/g),
  // Gate suppressions -- counted so the ratchet can't be satisfied by silencing.
  effectDiagnosticSuppressions: count(Araw, /@effect-diagnostics/g),
  eslintDisables: count(Araw, /eslint-disable/g),
};

const setMode = process.argv.includes("--set");
if (setMode || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`Baseline written to ${BASELINE}:`);
  for (const [k, v] of Object.entries(metrics))
    console.log(`  ${k.padEnd(30)} ${v}`);
  process.exit(0);
}

const base: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
let worse = 0;
let better = 0;

console.log("Effect debt (vs. baseline):");
for (const [k, v] of Object.entries(metrics)) {
  const b = base[k] ?? 0;
  const delta = v - b;
  const mark = delta > 0 ? "WORSE" : delta < 0 ? "better" : "";
  if (delta > 0) worse++;
  if (delta < 0) better++;
  const d = delta === 0 ? "" : ` (${delta > 0 ? "+" : ""}${delta})`;
  console.log(
    `  ${k.padEnd(30)} ${String(v).padStart(4)}${d.padEnd(7)} ${mark}`,
  );
}

if (worse > 0) {
  console.error(
    `\nFAIL: ${worse} metric(s) went up. Either fix it, or -- if the increase is\n` +
      `genuinely correct -- run \`npm run effect:debt -- --set\` in the same commit\n` +
      `so the regression is a reviewable line in the diff instead of silent drift.`,
  );
  process.exit(1);
}
if (better > 0) {
  console.log(
    `\n${better} metric(s) improved. Run \`npm run effect:debt -- --set\` to lock it in,\n` +
      `so the ratchet holds at the new level.`,
  );
}
console.log("\nOK — no regressions.");
