#!/usr/bin/env node
/**
 * Codemod: reorder declarations so they appear before their first use, and
 * hoist late `import` statements to the top of the file.
 *
 * Why a codemod instead of ESLint --fix?
 *   `@typescript-eslint/no-use-before-define` ships WITHOUT an autofixer
 *   because reordering arbitrary statements can change evaluation order,
 *   break TDZ semantics, or move side-effects. This script only performs
 *   reorderings that are safe under a narrow set of rules.
 *
 * Passes (each runs per file; re-run until 0 changes reported):
 *
 *   1. SCOPE REORDER
 *      For each statement list (the Program, plus every nested
 *      Block / ModuleBlock / CaseBlock body), if a `const`/`let`/`var`/
 *      `class`/`enum` declaration (including `export const`, `export enum`,
 *      etc.) appears AFTER the first sibling statement that references it,
 *      move the whole declaring statement just before that first referencing
 *      sibling. Function declarations are left alone (hoisted; the lint
 *      rule allows them via `functions: false`).
 *
 *   2. IMPORTS-FIRST
 *      Any top-level `import` declaration that appears after a non-import
 *      top-level statement is moved into the leading import block
 *      (mirrors `eslint-plugin-import`'s `import/first` autofix).
 *
 * Deliberately NOT done:
 *   - Reorder across scope boundaries.
 *   - Resolve transitive ordering in a single pass.
 *   - Touch `src/components/ui/**` (vendored shadcn), generated files
 *     (`*.gen.ts`), or `*.d.ts`.
 *
 * Usage:
 *   bun run lint:fix-order            # apply edits
 *   bun run lint:fix-order:dry        # print plan only
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import ts from "typescript";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry-run");

const SKIP = [
  /\/components\/ui\//,
  /\.gen\.ts$/,
  /\.d\.ts$/,
  /\/node_modules\//,
];

function listFiles() {
  const out = execSync("git ls-files src", { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !SKIP.some((re) => re.test(f)))
    .map((f) => join(ROOT, f));
}

/** Names introduced by a statement (only the kinds we move). */
function declaredNames(stmt) {
  const names = [];
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      collectBindingNames(d.name, names);
    }
  } else if (
    (ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) &&
    stmt.name
  ) {
    names.push(stmt.name.text);
  }
  return names;
}
function collectBindingNames(node, out) {
  if (ts.isIdentifier(node)) out.push(node.text);
  else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const el of node.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
    }
  }
}

/** All identifier texts referenced anywhere inside `stmt`. */
function referencedIdentifiers(stmt) {
  const found = new Set();
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isDeclName =
        (ts.isVariableDeclaration(p) && p.name === n) ||
        (ts.isParameter(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.name === n) ||
        ((ts.isFunctionDeclaration(p) ||
          ts.isClassDeclaration(p) ||
          ts.isEnumDeclaration(p) ||
          ts.isInterfaceDeclaration(p) ||
          ts.isTypeAliasDeclaration(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isPropertyDeclaration(p)) &&
          p.name === n) ||
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n && !p.initializer);
      if (!isDeclName) found.add(n.text);
    }
    n.forEachChild(visit);
  };
  visit(stmt);
  return found;
}

/**
 * Given a NodeArray of statements, return the reordered list of indices and
 * the moves performed. Pure; no I/O.
 */
function reorderStatements(stmts) {
  const declAt = new Map();
  stmts.forEach((s, i) => {
    for (const n of declaredNames(s)) {
      if (!declAt.has(n)) declAt.set(n, i);
    }
  });
  const moves = [];
  for (const [name, fromIdx] of declAt) {
    for (let i = 0; i < fromIdx; i++) {
      if (referencedIdentifiers(stmts[i]).has(name)) {
        moves.push({ name, from: fromIdx, to: i });
        break;
      }
    }
  }
  moves.sort((a, b) => b.from - a.from);
  const order = stmts.map((_, i) => i);
  for (const m of moves) {
    const cur = order.indexOf(m.from);
    const dest = order.indexOf(m.to);
    if (cur < 0 || dest < 0 || cur <= dest) continue;
    const [moved] = order.splice(cur, 1);
    order.splice(dest, 0, moved);
  }
  return { order, moves };
}

/** Hoist any ImportDeclaration that follows a non-import top-level stmt. */
function hoistImports(stmts) {
  // The desired final order: every import (preserving relative order), then
  // every non-import (preserving relative order).
  let firstNonImport = -1;
  const moves = [];
  for (let i = 0; i < stmts.length; i++) {
    const isImp = ts.isImportDeclaration(stmts[i]);
    if (!isImp && firstNonImport < 0) firstNonImport = i;
    else if (isImp && firstNonImport >= 0) {
      moves.push({ name: "<import>", from: i, to: firstNonImport });
    }
  }
  if (moves.length === 0) return { order: stmts.map((_, i) => i), moves: [] };
  const order = [];
  for (let i = 0; i < stmts.length; i++) if (ts.isImportDeclaration(stmts[i])) order.push(i);
  for (let i = 0; i < stmts.length; i++) if (!ts.isImportDeclaration(stmts[i])) order.push(i);
  return { order, moves };
}

/**
 * Apply `order` to `stmts` and return the replacement text for the span
 * [stmts[0].getFullStart(), stmts[stmts.length-1].getEnd()).
 */
function rebuildSpan(src, stmts, order) {
  return order
    .map((idx) => src.slice(stmts[idx].getFullStart(), stmts[idx].getEnd()))
    .join("");
}

/** Collect every statement list we want to consider in a file. */
function collectStatementLists(sf) {
  // Program scope only. Nested-block reordering is unsafe in general
  // because identifiers in sibling statements can resolve to outer-scope
  // bindings (shadowing); a same-name match would trigger a bogus move.
  return [{ stmts: sf.statements, depth: 0 }];
}

function processFile(file) {
  let src = readFileSync(file, "utf8");
  let totalMoves = [];

  // Run until stable, or up to 5 passes — multiple scopes may shift offsets
  // and we re-parse between passes to stay correct.
  for (let pass = 0; pass < 5; pass++) {
    const sf = ts.createSourceFile(
      file, src, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // Combine: program-scope (with imports-first), then each nested block.
    const lists = collectStatementLists(sf);
    // Sort by start offset DESC so we patch from the end of the file backwards.
    lists.sort((a, b) => b.stmts[0].getFullStart() - a.stmts[0].getFullStart());

    // Skip imports-first in test files that intentionally interleave
    // `vi.mock()` / `jest.mock()` calls between imports — those test runners
    // hoist mocks but the human-readable order is load-bearing for clarity.
    const skipImports = /\b(?:vi|jest)\.mock\s*\(/.test(src);

    let edits = []; // { start, end, replacement, moves }
    for (const { stmts } of lists) {
      const isProgram = stmts === sf.statements;
      const passes = [reorderStatements(stmts)];
      if (isProgram && !skipImports) passes.push(hoistImports(stmts));
      // Fold passes: apply first, then re-derive order for the second.
      let order = stmts.map((_, i) => i);
      let moves = [];
      for (const p of passes) {
        // Translate p.order (over original indices) by composing with `order`.
        const composed = p.order.map((i) => order[i]);
        order = composed;
        moves = moves.concat(p.moves);
      }
      // No-op?
      const isIdentity = order.every((v, i) => v === i);
      if (isIdentity) continue;
      const start = stmts[0].getFullStart();
      const end = stmts[stmts.length - 1].getEnd();
      edits.push({ start, end, replacement: rebuildSpan(src, stmts, order), moves });
    }

    if (edits.length === 0) break;
    // Apply edits from highest start to lowest.
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) {
      src = src.slice(0, e.start) + e.replacement + src.slice(e.end);
      totalMoves = totalMoves.concat(e.moves);
    }
  }

  return { file, changed: totalMoves.length, moves: totalMoves, newSrc: src };
}

let total = 0;
for (const f of listFiles()) {
  try {
    const r = processFile(f);
    if (r.changed === 0) continue;
    const original = readFileSync(f, "utf8");
    if (r.newSrc === original) continue;
    total += r.changed;
    const rel = relative(ROOT, f);
    console.log(`${DRY ? "[dry] " : ""}${rel}: ${r.changed} move(s)`);
    for (const m of r.moves) console.log(`    ${m.name}: ${m.from} -> ${m.to}`);
    if (!DRY) writeFileSync(f, r.newSrc, "utf8");
  } catch (e) {
    console.error(`SKIP ${relative(ROOT, f)}: ${e.message}`);
  }
}
console.log(`\n${DRY ? "Would perform" : "Performed"} ${total} move(s).`);
console.log("Re-run until output is 0, then: bun run lint && bunx tsc --noEmit");
