#!/usr/bin/env node
// Guards against accidental downgrades of TanStack packages that would
// reintroduce build/type errors (e.g. the `server` option on
// createFileRoute was added in @tanstack/react-router 1.168.0).
//
// Run in CI before lint/build, and locally via `bun run check:deps`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// pkg name -> minimum installed version (inclusive)
const REQUIREMENTS = {
  "@tanstack/react-router": "1.168.25",
  "@tanstack/react-start": "1.167.50",
};

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`Cannot parse version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(a, b) {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

const errors = [];
for (const [pkg, minVersion] of Object.entries(REQUIREMENTS)) {
  let installed;
  try {
    installed = JSON.parse(
      readFileSync(require.resolve(`${pkg}/package.json`), "utf8"),
    ).version;
  } catch (err) {
    errors.push(`${pkg}: not installed (${err.message})`);
    continue;
  }
  if (!gte(installed, minVersion)) {
    errors.push(
      `${pkg}: installed ${installed} is below required minimum ${minVersion}. ` +
        `Run \`bun add ${pkg}@^${minVersion}\` to restore a compatible version.`,
    );
  }
}

if (errors.length > 0) {
  console.error("[check:deps] TanStack version guard failed:\n");
  for (const e of errors) console.error("  - " + e);
  console.error(
    "\nThese minimums prevent regressions like the missing `server` option " +
      "on createFileRoute (added in @tanstack/react-router 1.168.0).",
  );
  process.exit(1);
}

console.log("[check:deps] TanStack versions OK.");
