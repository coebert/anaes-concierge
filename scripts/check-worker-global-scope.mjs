#!/usr/bin/env node
/**
 * Build-time guard: refuse to ship code that performs disallowed operations at
 * module top-level (global scope).
 *
 * Cloudflare Workers (the runtime that hosts our SSR + server functions) throws:
 *
 *   "Disallowed operation called within global scope. Asynchronous I/O
 *    (ex: fetch() or connect()), setting a timeout, and generating random
 *    values are not allowed within global scope."
 *
 * The whole isolate dies on import, so every request returns HTTP 500 until a
 * new deploy lands. This script walks `src/**` with the TypeScript parser and
 * fails the build when a top-level statement (i.e. NOT inside a function /
 * method / arrow / class body) hits a banned pattern:
 *
 *   - fetch(...), connect(...), setTimeout/setInterval/setImmediate(...), queueMicrotask(...)
 *   - crypto.randomUUID(), crypto.getRandomValues(...), crypto.subtle.*(...)
 *   - Math.random()
 *   - new Response(...), new Request(...), new WebSocket(...), new XMLHttpRequest(...), new EventSource(...)
 *   - Response.json(...), Response.redirect(...), Response.error(...)
 *   - dynamic import() calls
 *   - top-level `await`
 *
 * Scope: every TypeScript file under src/ that ends up in the Worker bundle.
 * Excluded: vendored shadcn UI, generated files, test files, `.d.ts`, and
 * `*.client.ts(x)` (those never run on the server).
 *
 * Usage:
 *   node scripts/check-worker-global-scope.mjs            # fail on violations
 *   node scripts/check-worker-global-scope.mjs --list     # print scanned files
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const EXCLUDE_DIR = new Set(["node_modules", "components/ui"]);
const EXCLUDE_FILE_RE = /(\.d\.ts|\.gen\.ts|\.test\.[tj]sx?|\.spec\.[tj]sx?|\.client\.tsx?)$/;

/** @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(SRC, full);
    if (EXCLUDE_DIR.has(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !EXCLUDE_FILE_RE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const BANNED_IDENT = new Set([
  "fetch",
  "connect",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
]);

// Member-access bans: object -> set of properties ("*" = any property).
const BANNED_MEMBER = {
  crypto: new Set(["randomUUID", "getRandomValues", "subtle"]),
  Math: new Set(["random"]),
  Response: new Set(["json", "redirect", "error"]),
};

const BANNED_CTOR = new Set(["Response", "Request", "WebSocket", "XMLHttpRequest", "EventSource"]);

/**
 * Return a violation message for the given node if it is a banned call/expr,
 * otherwise null. Does NOT recurse — caller controls traversal so we can skip
 * function bodies.
 */
function classify(node) {
  // Top-level await
  if (ts.isAwaitExpression(node)) {
    return "top-level `await` expression";
  }
  // Dynamic import() — import("mod")
  if (ts.isImportCallExpression(node)) {
    return "top-level dynamic `import(...)` call";
  }
  if (ts.isNewExpression(node)) {
    const e = node.expression;
    if (ts.isIdentifier(e) && BANNED_CTOR.has(e.text)) {
      return `top-level \`new ${e.text}(...)\``;
    }
  }
  if (ts.isCallExpression(node)) {
    const e = node.expression;
    if (ts.isIdentifier(e) && BANNED_IDENT.has(e.text)) {
      return `top-level \`${e.text}(...)\` call`;
    }
    if (ts.isPropertyAccessExpression(e)) {
      // Walk to root object identifier (e.g. crypto.subtle.digest -> crypto)
      let cur = e;
      const chain = [];
      while (ts.isPropertyAccessExpression(cur)) {
        chain.unshift(cur.name.text);
        if (!ts.isPropertyAccessExpression(cur.expression)) break;
        cur = cur.expression;
      }
      const root = cur.expression;
      if (ts.isIdentifier(root) && BANNED_MEMBER[root.text]) {
        const banned = BANNED_MEMBER[root.text];
        const firstProp = chain[0];
        if (banned.has(firstProp)) {
          return `top-level \`${root.text}.${chain.join(".")}(...)\` call`;
        }
      }
      // Also catch indirect access like window.fetch, globalThis.fetch, self.fetch
      const lastProp = chain[chain.length - 1];
      if (BANNED_IDENT.has(lastProp) && ts.isIdentifier(root)) {
        const rootName = root.text;
        if (rootName === "window" || rootName === "globalThis" || rootName === "self") {
          return `top-level \`${rootName}.${chain.join(".")}(...)\` call`;
        }
      }
    }
  }
  return null;
}

/**
 * Walk an expression/statement subtree WITHOUT descending into function
 * bodies, class bodies, or object-method bodies. Any node we recurse into is
 * still "top-level" from the runtime's perspective.
 */
function scanTopLevel(node, sourceFile, violations) {
  const v = classify(node);
  if (v) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ line: line + 1, col: character + 1, msg: v });
  }

  // Stop traversal at any new function/method scope — code inside only runs
  // when called, not at module load.
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return;
  }

  ts.forEachChild(node, (child) => scanTopLevel(child, sourceFile, violations));
}

function scanFile(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];
  // Only iterate top-level statements; for each, recurse but stop at function scopes.
  sf.statements.forEach((stmt) => scanTopLevel(stmt, sf, violations));
  return violations;
}

const files = walk(SRC);
if (process.argv.includes("--list")) {
  for (const f of files) console.log(relative(ROOT, f));
  process.exit(0);
}

let totalViolations = 0;
for (const file of files) {
  const vs = scanFile(file);
  if (vs.length === 0) continue;
  totalViolations += vs.length;
  console.error(`\n${relative(ROOT, file)}`);
  for (const v of vs) {
    console.error(`  ${v.line}:${v.col}  ${v.msg}`);
  }
}

if (totalViolations > 0) {
  console.error(
    `\n✖ ${totalViolations} disallowed Cloudflare Workers global-scope operation(s) found.`,
  );
  console.error(
    "  These crash the Worker isolate on startup with:",
  );
  console.error(
    '  "Disallowed operation called within global scope ..."',
  );
  console.error(
    "  Move the call inside a function/handler body so it runs per-request,",
  );
  console.error("  not at module load time.\n");
  process.exit(1);
}

console.log(`✓ Scanned ${files.length} file(s): no top-level disallowed operations.`);