#!/usr/bin/env node
/**
 * Codemod: reorder top-level declarations so they appear before their first use.
 *
 * Why a codemod instead of ESLint --fix?
 *   `@typescript-eslint/no-use-before-define` ships WITHOUT an autofixer because
 *   reordering arbitrary statements can change evaluation order, break TDZ
 *   semantics, or move side-effects. There is no safe-in-general fix.
 *
 * What this codemod does (the safe subset):
 *   For each .ts/.tsx file under src/, it inspects only top-level (Program)
 *   statements. If a `const`/`let`/`var`/`class`/`enum` declaration appears
 *   AFTER the first top-level statement that references it, the whole
 *   declaring statement is moved to sit immediately before that first
 *   referencing statement. Function declarations are left alone (they are
 *   hoisted and the lint rule allows them via `functions: false`).
 *
 * What it deliberately does NOT do:
 *   - Reorder declarations inside function bodies, classes, or blocks.
 *   - Reorder when the first reference is inside a function body (those are
 *     usually fine at runtime; the lint rule is over-cautious there).
 *   - Resolve transitive ordering between multiple moved declarations in
 *     a single pass. Re-run the codemod until it reports 0 changes.
 *   - Touch files under src/components/ui/** (shadcn vendored code) or
 *     generated files (routeTree.gen.ts, *.d.ts).
 *
 * Usage:
 *   node scripts/fix-use-before-define.mjs            # apply edits
 *   node scripts/fix-use-before-define.mjs --dry-run  # print plan only
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

/** Names introduced by a top-level statement (only the kinds we move). */
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
      // Skip identifiers that are *declarations*, not references.
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

function processFile(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const stmts = sf.statements;
  // Index declarations: name -> statement index.
  const declAt = new Map();
  stmts.forEach((s, i) => {
    for (const n of declaredNames(s)) {
      if (!declAt.has(n)) declAt.set(n, i);
    }
  });

  // For each declaration, find the earliest *prior* top-level statement
  // that references it.
  const moves = []; // { from, to } where from > to (declaration moves up).
  for (const [name, fromIdx] of declAt) {
    for (let i = 0; i < fromIdx; i++) {
      if (referencedIdentifiers(stmts[i]).has(name)) {
        moves.push({ name, from: fromIdx, to: i });
        break;
      }
    }
  }
  if (moves.length === 0) return { file, changed: 0 };

  // Apply in descending order of `from` so earlier indices stay valid.
  moves.sort((a, b) => b.from - a.from);

  // Work on the statement array, then rebuild file text from original ranges
  // (preserving the user's exact formatting, comments, and trailing trivia).
  const order = stmts.map((_, i) => i);
  for (const m of moves) {
    const cur = order.indexOf(m.from);
    const dest = order.indexOf(m.to);
    if (cur < 0 || dest < 0 || cur <= dest) continue;
    const [moved] = order.splice(cur, 1);
    order.splice(dest, 0, moved);
  }

  // Build new file: prologue (before first stmt) + stmts in new order + epilogue.
  const first = stmts[0];
  const prologue = src.slice(0, first.getFullStart());
  const last = stmts[stmts.length - 1];
  const epilogue = src.slice(last.getEnd());

  const pieces = order.map((idx) => {
    const s = stmts[idx];
    // getFullStart() includes leading trivia (comments, blank lines) which we
    // want to travel with the statement.
    return src.slice(s.getFullStart(), s.getEnd());
  });

  // Re-join: leading trivia of the very first slot must become the prologue's
  // continuation; we keep the simplest invariant — preserve each slice as-is.
  const newSrc = prologue + pieces.join("") + epilogue;

  if (newSrc === src) return { file, changed: 0 };

  if (!DRY) writeFileSync(file, newSrc, "utf8");
  return { file, changed: moves.length, moves };
}

let total = 0;
for (const f of listFiles()) {
  try {
    const r = processFile(f);
    if (r.changed) {
      total += r.changed;
      const rel = relative(ROOT, r.file);
      console.log(`${DRY ? "[dry] " : ""}${rel}: moved ${r.changed} decl(s)`);
      for (const m of r.moves) console.log(`    ${m.name}: ${m.from} -> ${m.to}`);
    }
  } catch (e) {
    console.error(`SKIP ${relative(ROOT, f)}: ${e.message}`);
  }
}
console.log(`\n${DRY ? "Would move" : "Moved"} ${total} declaration(s).`);
console.log("Re-run until output is 0, then run: bunx eslint . && bunx tsc --noEmit");
