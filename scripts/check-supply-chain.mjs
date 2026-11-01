#!/usr/bin/env node
// Supply-chain guard. Runs `bun audit --json` against the COMMITTED bun.lock
// (the exact tree CI installs with --frozen-lockfile and deploys) — no fresh
// resolution, no alternate lockfile.
//
// FAIL CLOSED: any scan, network, spawn or JSON problem is exit 2, never 0.
// An `{"error": {...}}` payload (e.g. ENOAUDIT) is an error, not "clean".
//
// Exit codes: 0 = no advisories at/above level, 1 = advisories found, 2 = scan error.
// Usage: node scripts/check-supply-chain.mjs [--level=low|moderate|high|critical]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ORDER = ["low", "moderate", "high", "critical"];

/**
 * Pure evaluation of `bun audit --json` output. Exported for tests.
 * @returns {{ code: 0|1|2, message: string, counts?: Record<string, number>, offending?: string[] }}
 */
export function evaluateAudit(stdout, level = "moderate") {
  if (!ORDER.includes(level)) return { code: 2, message: `unknown --level=${level}` };
  const text = String(stdout ?? "").trim();
  if (!text) return { code: 2, message: "bun audit produced no output (scan did not run)" };
  let report;
  try {
    report = JSON.parse(text);
  } catch (e) {
    return { code: 2, message: `bun audit output is not JSON: ${e.message}` };
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { code: 2, message: "bun audit JSON has an unexpected shape" };
  }
  if ("error" in report) {
    const err = report.error;
    const code = err && typeof err === "object" ? (err.code ?? "unknown") : String(err);
    return { code: 2, message: `bun audit reported an error (${code}) — treating as failure` };
  }
  const threshold = ORDER.indexOf(level);
  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
  const offending = [];
  for (const [name, advisories] of Object.entries(report)) {
    if (!Array.isArray(advisories))
      return { code: 2, message: `unexpected advisory list for ${name}` };
    for (const adv of advisories) {
      const sev = adv?.severity;
      if (!ORDER.includes(sev))
        return { code: 2, message: `unknown severity "${sev}" for ${name}` };
      counts[sev] += 1;
      if (ORDER.indexOf(sev) >= threshold)
        offending.push(
          `${sev.padEnd(8)} ${name} ${adv.vulnerable_versions ?? ""} ${adv.url ?? ""}`,
        );
    }
  }
  return offending.length
    ? { code: 1, message: `${offending.length} advisory(ies) at/above ${level}`, counts, offending }
    : { code: 0, message: `no advisories at/above ${level}`, counts, offending };
}

function main() {
  const level = (process.argv.find((a) => a.startsWith("--level=")) ?? "--level=moderate").split(
    "=",
  )[1];
  if (!existsSync("bun.lock")) {
    console.error("[audit] bun.lock not found — refusing to scan a fresh resolution");
    process.exit(2);
  }
  const r = spawnSync("bun", ["audit", "--json"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    console.error(`[audit] could not run bun audit: ${r.error.message}`);
    process.exit(2);
  }
  // bun audit exits 1 when advisories exist; other non-zero codes are errors.
  if (r.status !== 0 && r.status !== 1) {
    console.error(`[audit] bun audit exited ${r.status}: ${(r.stderr ?? "").slice(0, 500)}`);
    process.exit(2);
  }
  const res = evaluateAudit(r.stdout, level);
  if (
    res.code === 0 &&
    r.status === 1 &&
    res.counts &&
    Object.values(res.counts).every((n) => n === 0)
  ) {
    console.error("[audit] bun audit exited 1 but reported no advisories — treating as failure");
    process.exit(2);
  }
  console.log(`[audit] ${res.message}${res.counts ? ` ${JSON.stringify(res.counts)}` : ""}`);
  for (const line of res.offending ?? []) console.log(`  ${line}`);
  process.exit(res.code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
