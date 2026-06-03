/**
 * Test suite for the no-use-before-define codemod.
 *
 * Each fixture is a pair of files under scripts/__fixtures__/fix-use-before-define/:
 *   - <name>.input.ts        — source fed into the codemod
 *   - <name>.expected.ts     — exact expected output (when a change is asserted)
 *
 * "no-op" fixtures only need an .input.ts file; the test asserts the
 * codemod returns the input unchanged and reports zero moves. This is the
 * key guard against false positives (the failure mode the user flagged
 * when we attempted nested-block reordering).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — JS ESM, no .d.ts.
import { processSource } from "./fix-use-before-define.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, "__fixtures__", "fix-use-before-define");

function read(name: string) {
  return readFileSync(join(FIX_DIR, name), "utf8");
}

/** Run the codemod and return its result. */
function run(inputName: string) {
  return processSource(read(inputName), join(FIX_DIR, inputName)) as {
    newSrc: string;
    moves: Array<{ name: string; from: number; to: number }>;
  };
}

describe("fix-use-before-define codemod — true positives", () => {
  // Each entry: fixture base name (input + expected files must both exist).
  const cases = [
    "enum-reorder",
    "exported-const",
    "class-reorder",
    "use-client-directive",
  ];

  it.each(cases)("%s: matches the expected output", (base) => {
    const { newSrc, moves } = run(`${base}.input.ts`);
    expect(newSrc).toBe(read(`${base}.expected.ts`));
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe("fix-use-before-define codemod — must NOT reorder (false-positive guard)", () => {
  // Pure no-op fixtures: no .expected file; input must come back byte-identical.
  const noopCases = [
    "noop",
    "types-untouched",
    "shadowing",
    "vi-mock-preserved",
    "function-decl-untouched",
  ];

  it.each(noopCases)("%s: source is unchanged and zero moves are reported", (base) => {
    const input = read(`${base}.input.ts`);
    const { newSrc, moves } = run(`${base}.input.ts`);
    expect(newSrc).toBe(input);
    expect(moves).toHaveLength(0);
  });
});

describe("fix-use-before-define codemod — fixture hygiene", () => {
  it("every .expected.ts has a sibling .input.ts (and vice versa where relevant)", () => {
    const files = readdirSync(FIX_DIR);
    const expectedBases = files
      .filter((f) => f.endsWith(".expected.ts"))
      .map((f) => f.replace(/\.expected\.ts$/, ""));
    for (const base of expectedBases) {
      expect(existsSync(join(FIX_DIR, `${base}.input.ts`))).toBe(true);
    }
  });

  it("is idempotent: running the codemod twice yields the same output", () => {
    const inputs = readdirSync(FIX_DIR).filter((f) => f.endsWith(".input.ts"));
    for (const f of inputs) {
      const once = processSource(read(f), join(FIX_DIR, f)) as { newSrc: string };
      const twice = processSource(once.newSrc, join(FIX_DIR, f)) as { newSrc: string };
      expect(twice.newSrc).toBe(once.newSrc);
    }
  });
});
