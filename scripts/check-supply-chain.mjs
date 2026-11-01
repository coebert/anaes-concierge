#!/usr/bin/env node
// Supply-chain guard: scans the COMMITTED bun.lock (the exact resolutions that
// get installed with --frozen-lockfile and deployed) against the npm bulk
// advisory API. It never re-resolves package.json, so a vulnerable pinned
// resolution in the lockfile cannot be hidden by a fresh resolve.
//
// Exit codes: 0 = no advisories at/above the fail level, 1 = advisories found,
// 2 = lockfile/network error (fail closed).
//
// Usage: node scripts/check-supply-chain.mjs [--level=moderate|high|critical] [--lock=bun.lock]
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const ORDER = ["low", "moderate", "high", "critical"];
const failLevel = args.level ?? "moderate";
const lockPath = args.lock ?? "bun.lock";

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text) {
  const cleaned = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

/** Map of package name -> sorted unique registry versions found in the lock. */
export function collectVersions(lock) {
  const out = new Map();
  for (const entry of Object.values(lock.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const spec = entry[0];
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    // Skip tarball/git/workspace resolutions; only registry semver versions.
    if (!/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version)) continue;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

async function main() {
  let lock;
  try {
    lock = parseBunLock(readFileSync(lockPath, "utf8"));
  } catch (err) {
    console.error(`[audit] cannot read/parse ${lockPath}: ${err.message}`);
    process.exit(2);
  }
  const versions = collectVersions(lock);
  const body = Object.fromEntries(versions);
  let res;
  try {
    res = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error(`[audit] advisory API unreachable: ${err.message}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`[audit] advisory API HTTP ${res.status}`);
    process.exit(2);
  }
  const report = await res.json();
  const threshold = ORDER.indexOf(failLevel);
  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
  const offending = [];
  for (const [name, advisories] of Object.entries(report)) {
    for (const adv of advisories) {
      counts[adv.severity] = (counts[adv.severity] ?? 0) + 1;
      if (ORDER.indexOf(adv.severity) >= threshold) {
        offending.push(`  - ${name} ${versions.get(name)?.join(",")} (${adv.severity}) ${adv.title} [${adv.vulnerable_versions}]`);
      }
    }
  }
  console.log(
    `[audit] ${lockPath}: ${versions.size} packages; advisories critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low}`,
  );
  if (offending.length > 0) {
    console.error(`[audit] ${offending.length} advisories at or above "${failLevel}":`);
    console.error(offending.join("\n"));
    process.exit(1);
  }
  console.log(`[audit] no advisories at or above "${failLevel}".`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
