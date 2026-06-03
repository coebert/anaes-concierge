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

/**
 * Generate a large synthetic TypeScript module that exercises every kind of
 * reorder the codemod handles, plus shadowing decoys that must NOT trigger
 * a move. After ONE pass the codemod's output must be byte-identical to
 * itself on every subsequent pass — idempotency at scale, not just on
 * small fixtures.
 */
function generateStressSource(count: number): string {
  const lines: string[] = [];
  lines.push(`import { existing } from "./a";`);
  lines.push(``);
  for (let i = 0; i < count; i++) {
    lines.push(`export function useConst${i}() { return CONST_${i}; }`);
  }
  for (let i = 0; i < count; i++) {
    lines.push(`export const READ_ENUM_${i} = Level${i}.A;`);
  }
  for (let i = 0; i < count; i++) {
    lines.push(`export const makeWidget${i} = () => new Widget${i}();`);
  }
  // Shadowing decoys: each refers to `errN` only inside a catch clause, so
  // the later `const errN` must NOT be hoisted above this block.
  for (let i = 0; i < count; i++) {
    lines.push(
      `export function shadow${i}() { try { throw 0; } catch (err${i}) { return err${i}; } }`,
    );
  }
  // Non-import statement, then a late import that must hoist.
  lines.push(``);
  lines.push(`export const SENTINEL = existing();`);
  lines.push(`import { late } from "./late";`);
  lines.push(`export const lateRef = late;`);
  lines.push(``);
  // Targets of the forward references.
  for (let i = 0; i < count; i++) {
    lines.push(`export const CONST_${i} = ${i};`);
  }
  for (let i = 0; i < count; i++) {
    lines.push(`export enum Level${i} { A = "a${i}", B = "b${i}" }`);
  }
  for (let i = 0; i < count; i++) {
    lines.push(`export class Widget${i} { id = ${i}; }`);
  }
  // Outer bindings sharing the name of the catch params above. These MUST
  // stay in place — they are not referenced outside their own (shadowed)
  // catch clauses.
  for (let i = 0; i < count; i++) {
    lines.push(`export const err${i} = new Error("outer-${i}");`);
  }
  return lines.join("\n") + "\n";
}

describe("fix-use-before-define codemod — stress fixture", () => {
  const COUNT = 30; // 30 of each kind → 90 reorderable + 30 shadow decoys.
  const filename = "stress-synthetic.ts";

  it("first pass produces output that is byte-identical to every subsequent pass", { timeout: 30000 }, () => {
    const original = generateStressSource(COUNT);
    const pass1 = processSource(original, filename) as {
      newSrc: string;
      moves: Array<{ name: string }>;
    };

    // Sanity: the first pass actually did meaningful work.
    expect(pass1.newSrc).not.toBe(original);
    // Lower bound: at minimum every CONST_/Level/Widget forward ref plus the
    // one late import should have been moved. (Internal multi-pass folding
    // may inflate the count slightly — that's OK, we don't pin the exact
    // number.)
    expect(pass1.moves.length).toBeGreaterThanOrEqual(3 * COUNT + 1);
    // Shadowing decoys MUST NOT contribute any moves.
    expect(pass1.moves.some((m) => /^err\d+$/.test(m.name))).toBe(false);

    // Core assertion: byte-identical output across many subsequent runs.
    let prev = pass1.newSrc;
    for (let i = 0; i < 4; i++) {
      const r = processSource(prev, filename) as {
        newSrc: string;
        moves: unknown[];
      };
      expect(r.moves).toHaveLength(0);
      expect(r.newSrc).toBe(prev);
      prev = r.newSrc;
    }
  });

  it("outer `errN` consts are preserved verbatim (shadowing decoys never move)", { timeout: 30000 }, () => {
    const original = generateStressSource(COUNT);
    const { newSrc } = processSource(original, filename) as { newSrc: string };
    for (let i = 0; i < COUNT; i++) {
      expect(newSrc).toContain(`export const err${i} = new Error("outer-${i}");`);
    }
  });
});
