#!/usr/bin/env node
// Supply-chain guard: fails CI when high or moderate severity advisories
// exist in the dependency tree. Mirrors the Lovable supply-chain scanner
// findings `vulnerable_dependencies_high` / `vulnerable_dependencies_medium`.
//
// Strategy: generate a package-lock.json from package.json (no install),
// then run `npm audit --json` against it. Exits non-zero if any advisory
// at severity >= moderate is reported.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAIL_LEVELS = new Set(["moderate", "high", "critical"]);

const work = mkdtempSync(join(tmpdir(), "audit-"));
cpSync("package.json", join(work, "package.json"));

// Generate a package-lock without installing node_modules (much faster).
const install = spawnSync(
  "npm",
  ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--silent"],
  { cwd: work, stdio: ["ignore", "inherit", "inherit"] },
);
if (install.status !== 0) {
  console.error("[audit] failed to generate package-lock.json");
  process.exit(install.status ?? 1);
}

const result = spawnSync("npm", ["audit", "--json"], {
  cwd: work,
  encoding: "utf8",
});
const stdout = result.stdout || "";
let report;
try {
  report = JSON.parse(stdout);
} catch {
  console.error("[audit] could not parse npm audit output:");
  console.error(stdout);
  console.error(result.stderr || "");
  process.exit(1);
}

const meta = report.metadata?.vulnerabilities ?? {};
const offending = Object.entries(meta)
  .filter(([level, count]) => FAIL_LEVELS.has(level) && Number(count) > 0)
  .map(([level, count]) => `${count} ${level}`);

if (offending.length > 0) {
  console.error(
    `[audit] supply-chain scan failed — found: ${offending.join(", ")}`,
  );
  // Surface the per-package detail so the failure is actionable.
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    if (!FAIL_LEVELS.has(v.severity)) continue;
    const fix = v.fixAvailable
      ? typeof v.fixAvailable === "object"
        ? ` -> ${v.fixAvailable.name}@${v.fixAvailable.version}`
        : " (fix available)"
      : "";
    console.error(`  - ${name} (${v.severity})${fix}`);
  }
  console.error(
    "\nFails on internal_ids vulnerable_dependencies_high / vulnerable_dependencies_medium.",
  );
  process.exit(1);
}

console.log("[audit] no high or moderate advisories.");
