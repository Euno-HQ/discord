#!/usr/bin/env node
/**
 * Guard: assert the Effect-TS library never reaches the CLIENT bundle.
 *
 * Why a sourcemap-based check (not grep): the production client bundle is
 * minified and Effect's code is inlined, so `import ... from "effect"` statements
 * are gone — a text grep cannot find them. The build emits sourcemaps whose
 * `sources` arrays still list every original module path that contributed to a
 * chunk, including `node_modules/effect/...` and `node_modules/@effect/...`.
 * Inspecting those is a reliable module-graph signal with no new runtime
 * dependency. We delete the client maps after inspecting so the deploy artifact
 * doesn't ship sourcemaps.
 *
 * Run via `npm run check:client-bundle` (it builds first). Pass `--no-build` to
 * inspect an existing build/client tree.
 *
 * Exit code 0 = clean (no Effect in client). Non-zero = leak detected or no
 * maps found to inspect.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = "build/client";

// Matches original-source paths under the Effect packages inside node_modules,
// tolerant of pnpm's flattened `.pnpm/effect@x.y.z/node_modules/effect/` layout.
// - `effect` (core):  .../node_modules/effect/...
// - `@effect/*`:       .../node_modules/@effect/sql/...
const EFFECT_SOURCE =
  /node_modules\/(?:\.pnpm\/[^/]*\/node_modules\/)?(?:@effect\/|effect\/)/;

function fail(message: string): never {
  console.error(`\n[check:client-bundle] FAIL: ${message}\n`);
  process.exit(1);
}

const shouldBuild = !process.argv.includes("--no-build");

if (shouldBuild) {
  console.log(
    "[check:client-bundle] Building client bundle (npm run build:app)…",
  );
  // Inherit stdio so build output/errors surface in CI logs.
  execFileSync("npm", ["run", "build:app"], { stdio: "inherit" });
}

if (!existsSync(CLIENT_DIR)) {
  fail(`${CLIENT_DIR} does not exist — did the client build run?`);
}

/** Recursively collect all `.map` files under a directory. */
function collectMaps(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectMaps(full));
    } else if (entry.endsWith(".map")) {
      out.push(full);
    }
  }
  return out;
}

const maps = collectMaps(CLIENT_DIR);

if (maps.length === 0) {
  fail(
    `No .map files found under ${CLIENT_DIR}. This check relies on sourcemaps ` +
      `(vite.config.ts build.sourcemap). Without maps it cannot verify the ` +
      `module graph — refusing to report a false pass.`,
  );
}

const leaks: string[] = [];
for (const mapPath of maps) {
  let parsed: { sources?: unknown };
  try {
    parsed = JSON.parse(readFileSync(mapPath, "utf8")) as { sources?: unknown };
  } catch {
    fail(`Could not parse sourcemap ${mapPath}.`);
  }
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  for (const source of sources) {
    if (typeof source === "string" && EFFECT_SOURCE.test(source)) {
      leaks.push(`${mapPath}  <-  ${source}`);
    }
  }
}

// Clean up client sourcemaps so the deploy artifact doesn't ship them.
for (const mapPath of maps) {
  rmSync(mapPath, { force: true });
}

if (leaks.length > 0) {
  console.error(
    "\n[check:client-bundle] Effect modules leaked into the CLIENT bundle:\n",
  );
  for (const leak of leaks) console.error(`  ${leak}`);
  fail(
    `${leaks.length} Effect source(s) reached the client bundle. Effect must ` +
      `stay server-side — move the offending code into a *.server.ts module ` +
      `(or a confirmed server-only dir) and reach it from a route loader/action. ` +
      `See notes/EFFECT.md.`,
  );
}

console.log(
  `[check:client-bundle] OK — inspected ${maps.length} client sourcemap(s); ` +
    `no Effect modules in the client bundle. (client .map files removed)`,
);
