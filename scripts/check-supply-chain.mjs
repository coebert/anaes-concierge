#!/usr/bin/env node
// Supply-chain guard for the COMMITTED bun.lock (the exact tree CI installs
// with --frozen-lockfile and deploys). bun.lock is the only lockfile.
//
// FAIL CLOSED. Exit codes:
//   0 = report valid, every registry package scanned, no advisory at/above level
//       (reviewed non-registry packages are listed explicitly as UNSCANNED)
//   1 = advisories at/above level
//   2 = anything we cannot trust: missing/invalid lock, lock not matching the
//       root manifest, empty tree, spawn/timeout/network failure, unexpected
//       exit code, non-JSON or schema-invalid report, unknown severity,
//       exit-code/report disagreement, unreviewed non-registry package.
//
// Usage: node scripts/check-supply-chain.mjs [--level=low|moderate|high|critical]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ORDER = ["low", "moderate", "high", "critical"];
const fail = (message) => ({ code: 2, message });

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text) {
  const cleaned = String(text).replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

const REGISTRY_RESOLUTION = /^(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+[^\s/]*$/;

/**
 * Validate the lock against the root manifest. Returns the list of
 * non-registry (tarball/git/file) packages that `bun audit` cannot check.
 */
export function validateLock(lockText, manifestText) {
  let lock, manifest;
  try {
    lock = parseBunLock(lockText);
  } catch (e) {
    return { error: `bun.lock is not parseable: ${e.message}` };
  }
  try {
    manifest = JSON.parse(manifestText);
  } catch (e) {
    return { error: `package.json is not parseable: ${e.message}` };
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock))
    return { error: "bun.lock has an unexpected shape" };
  if (typeof lock.lockfileVersion !== "number") return { error: "bun.lock lacks lockfileVersion" };
  const root = lock.workspaces?.[""];
  if (!root || typeof root !== "object") return { error: "bun.lock lacks the root workspace" };
  const pkgs = lock.packages;
  if (!pkgs || typeof pkgs !== "object" || Array.isArray(pkgs) || Object.keys(pkgs).length === 0)
    return { error: "bun.lock has an empty resolved package tree" };

  const mismatches = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const want = manifest[field] ?? {};
    const have = root[field] ?? {};
    for (const [name, spec] of Object.entries(want)) {
      if (have[name] !== spec)
        mismatches.push(`${field}.${name}: manifest ${spec} vs lock ${have[name] ?? "(missing)"}`);
      else if (!pkgs[name]) mismatches.push(`${field}.${name}: not resolved in lock packages`);
    }
    for (const name of Object.keys(have))
      if (!(name in want)) mismatches.push(`${field}.${name}: in lock but not in manifest`);
  }
  if (mismatches.length)
    return {
      error: `bun.lock does not match package.json (${mismatches.length}): ${mismatches.slice(0, 10).join("; ")}`,
    };

  const nonRegistry = [];
  for (const [key, entry] of Object.entries(pkgs)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string")
      return { error: `bun.lock entry ${key} is malformed` };
    if (!REGISTRY_RESOLUTION.test(entry[0]))
      nonRegistry.push({
        key,
        resolution: entry[0],
        integrity: typeof entry[2] === "string" ? entry[2] : null,
      });
  }
  return { packageCount: Object.keys(pkgs).length, nonRegistry };
}

/** Each non-registry package must match a reviewed entry exactly. */
export function checkUnscanned(nonRegistry, reviewed) {
  const unreviewed = [];
  const listed = [];
  for (const p of nonRegistry) {
    const r = (reviewed ?? []).find((x) => x.key === p.key);
    if (!r || r.resolution !== p.resolution || !p.integrity || r.integrity !== p.integrity)
      unreviewed.push(p);
    else listed.push(p);
  }
  return { unreviewed, listed };
}

function validAdvisory(a) {
  return (
    a &&
    typeof a === "object" &&
    !Array.isArray(a) &&
    ORDER.includes(a.severity) &&
    (typeof a.id === "number" || typeof a.id === "string") &&
    typeof a.title === "string" &&
    typeof a.url === "string" &&
    typeof a.vulnerable_versions === "string"
  );
}

/**
 * Pure evaluation of `bun audit --json` stdout + exit status.
 * @returns {{ code: 0|1|2, message: string, counts?: Record<string, number>, offending?: string[] }}
 */
export function evaluateAudit(stdout, level = "moderate", status = undefined) {
  if (!ORDER.includes(level)) return fail(`unknown --level=${level}`);
  const text = String(stdout ?? "").trim();
  if (!text) return fail("bun audit produced no output (scan did not run)");
  let report;
  try {
    report = JSON.parse(text);
  } catch (e) {
    return fail(`bun audit output is not JSON: ${e.message}`);
  }
  if (report === null || typeof report !== "object" || Array.isArray(report))
    return fail("bun audit JSON is not an advisory object");
  if ("error" in report) {
    const err = report.error;
    const code = err && typeof err === "object" ? (err.code ?? "unknown") : String(err);
    return fail(`bun audit reported an error (${code})`);
  }
  const threshold = ORDER.indexOf(level);
  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
  const offending = [];
  for (const [name, advisories] of Object.entries(report)) {
    if (!Array.isArray(advisories) || advisories.length === 0)
      return fail(`advisory list for ${name} is missing or empty`);
    for (const adv of advisories) {
      if (!validAdvisory(adv))
        return fail(`malformed advisory for ${name}: ${JSON.stringify(adv).slice(0, 200)}`);
      counts[adv.severity] += 1;
      if (ORDER.indexOf(adv.severity) >= threshold)
        offending.push(`${adv.severity.padEnd(8)} ${name} ${adv.vulnerable_versions} ${adv.url}`);
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (status !== undefined) {
    if (status !== 0 && status !== 1) return fail(`bun audit exited ${status}`);
    if (status === 1 && total === 0) return fail("bun audit exited 1 but reported no advisories");
    if (status === 0 && total > 0) return fail("bun audit exited 0 but reported advisories");
  }
  return offending.length
    ? { code: 1, message: `${offending.length} advisory(ies) at/above ${level}`, counts, offending }
    : {
        code: 0,
        message: `no advisories at/above ${level} among scanned registry packages`,
        counts,
        offending,
      };
}

export function run({
  cwd = process.cwd(),
  level = "moderate",
  bun = "bun",
  log = console.log,
  err = console.error,
} = {}) {
  const lockPath = path.join(cwd, "bun.lock");
  const manifestPath = path.join(cwd, "package.json");
  if (!existsSync(lockPath))
    return (err("[audit] bun.lock not found — refusing to scan a fresh resolution"), 2);
  if (!existsSync(manifestPath)) return (err("[audit] package.json not found"), 2);
  if (existsSync(path.join(cwd, "package-lock.json")))
    return (
      err("[audit] stale package-lock.json present — bun.lock is the only authoritative lockfile"),
      2
    );
  const lock = validateLock(readFileSync(lockPath, "utf8"), readFileSync(manifestPath, "utf8"));
  if (lock.error) return (err(`[audit] ${lock.error}`), 2);

  const reviewedPath = path.join(cwd, "scripts", "supply-chain-unscanned.json");
  let reviewed = [];
  if (existsSync(reviewedPath)) {
    try {
      reviewed = JSON.parse(readFileSync(reviewedPath, "utf8"));
      if (!Array.isArray(reviewed)) throw new Error("not an array");
    } catch (e) {
      return (err(`[audit] supply-chain-unscanned.json invalid: ${e.message}`), 2);
    }
  }
  const { unreviewed, listed } = checkUnscanned(lock.nonRegistry, reviewed);
  if (unreviewed.length) {
    for (const p of unreviewed)
      err(`[audit] UNREVIEWED non-registry package (not scanned): ${p.resolution}`);
    return 2;
  }

  const r = spawnSync(bun, ["audit", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return (err(`[audit] could not run bun audit: ${r.error.message}`), 2);
  if (r.signal) return (err(`[audit] bun audit killed by ${r.signal}`), 2);
  const res = evaluateAudit(r.stdout, level, r.status);
  if (res.code === 2) {
    err(`[audit] ${res.message}${r.stderr ? ` — stderr: ${String(r.stderr).slice(0, 300)}` : ""}`);
    return 2;
  }
  log(`[audit] lock: ${lock.packageCount} packages; ${res.message} ${JSON.stringify(res.counts)}`);
  for (const line of res.offending ?? []) log(`  ${line}`);
  for (const p of listed)
    log(`[audit] UNSCANNED (reviewed, not covered by advisory DB): ${p.resolution}`);
  return res.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const level = (process.argv.find((a) => a.startsWith("--level=")) ?? "--level=moderate").split(
    "=",
  )[1];
  process.exit(run({ level, bun: process.env.SUPPLY_CHAIN_BUN || "bun" }));
}
