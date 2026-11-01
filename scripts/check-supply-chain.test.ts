/**
 * Executes the real scanner script (as CI does) against fixture projects with
 * a fake `bun` on SUPPLY_CHAIN_BUN, so every exit path is proven end to end.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateAudit, validateLock } from "./check-supply-chain.mjs";

const SCRIPT = path.resolve(__dirname, "check-supply-chain.mjs");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const MANIFEST = {
  name: "fx",
  dependencies: { leftpad: "^1.0.0" },
  devDependencies: { tool: "2.0.0" },
};
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fx",
      "dependencies": { "leftpad": "^1.0.0", },
      "devDependencies": { "tool": "2.0.0", },
    },
  },
  "packages": {
    "leftpad": ["leftpad@1.3.0", "", {}, "sha512-aaa"],
    "tool": ["tool@2.0.0", "", {}, "sha512-bbb"],
  }
}
`;
const ADV = (severity: unknown, extra: Record<string, unknown> = {}) => ({
  id: 1,
  url: "https://github.com/advisories/GHSA-x",
  title: "t",
  severity,
  vulnerable_versions: "<2",
  ...extra,
});

function project(opts: {
  stdout?: string;
  exit?: number;
  lock?: string | null;
  manifest?: unknown;
  extraFiles?: Record<string, string>;
  bunMissing?: boolean;
}) {
  const d = mkdtempSync(path.join(tmpdir(), "sc-"));
  dirs.push(d);
  writeFileSync(path.join(d, "package.json"), JSON.stringify(opts.manifest ?? MANIFEST));
  if (opts.lock !== null) writeFileSync(path.join(d, "bun.lock"), opts.lock ?? LOCK);
  for (const [f, c] of Object.entries(opts.extraFiles ?? {})) {
    mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    writeFileSync(path.join(d, f), c);
  }
  const fake = path.join(d, "fake-bun.sh");
  writeFileSync(
    fake,
    `#!/bin/sh\ncat <<'__EOF__'\n${opts.stdout ?? ""}\n__EOF__\nexit ${opts.exit ?? 0}\n`,
  );
  chmodSync(fake, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: d,
    encoding: "utf8",
    env: { ...process.env, SUPPLY_CHAIN_BUN: opts.bunMissing ? path.join(d, "nope") : fake },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("check-supply-chain (executed)", () => {
  it("valid clean {} => 0, and never claims a global clean", () => {
    const r = project({ stdout: "{}", exit: 0 });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/among scanned registry packages/);
  });
  it("high advisory => 1", () => {
    expect(project({ stdout: JSON.stringify({ tool: [ADV("high")] }), exit: 1 }).code).toBe(1);
  });
  it("moderate advisory => 1 at default level", () => {
    expect(project({ stdout: JSON.stringify({ tool: [ADV("moderate")] }), exit: 1 }).code).toBe(1);
  });
  it("low advisory only => 0 at moderate level", () => {
    expect(project({ stdout: JSON.stringify({ tool: [ADV("low")] }), exit: 1 }).code).toBe(0);
  });
  it("registry error payload (ENOAUDIT) => 2", () => {
    expect(project({ stdout: JSON.stringify({ error: { code: "ENOAUDIT" } }), exit: 1 }).code).toBe(
      2,
    );
  });
  it("[] => 2", () => expect(project({ stdout: "[]", exit: 0 }).code).toBe(2));
  it("null => 2", () => expect(project({ stdout: "null", exit: 0 }).code).toBe(2));
  it("advisory missing severity => 2", () => {
    const adv = ADV("high");
    delete (adv as Record<string, unknown>).severity;
    expect(project({ stdout: JSON.stringify({ tool: [adv] }), exit: 1 }).code).toBe(2);
  });
  it("unknown severity => 2", () => {
    expect(project({ stdout: JSON.stringify({ tool: [ADV("severe")] }), exit: 1 }).code).toBe(2);
  });
  it("empty per-package advisory list => 2", () => {
    expect(project({ stdout: JSON.stringify({ tool: [] }), exit: 0 }).code).toBe(2);
  });
  it("malformed JSON => 2", () => expect(project({ stdout: "{not json", exit: 0 }).code).toBe(2));
  it("empty output => 2", () => expect(project({ stdout: "", exit: 0 }).code).toBe(2));
  it("exit 1 with no advisories => 2", () =>
    expect(project({ stdout: "{}", exit: 1 }).code).toBe(2));
  it("exit 0 with advisories => 2", () => {
    expect(project({ stdout: JSON.stringify({ tool: [ADV("high")] }), exit: 0 }).code).toBe(2);
  });
  it("unexplained exit code => 2", () => expect(project({ stdout: "{}", exit: 3 }).code).toBe(2));
  it("bun missing (spawn failure) => 2", () =>
    expect(project({ stdout: "{}", bunMissing: true }).code).toBe(2));
  it("missing lock => 2", () => expect(project({ stdout: "{}", lock: null }).code).toBe(2));
  it("invalid lock {} => 2", () => expect(project({ stdout: "{}", lock: "{}" }).code).toBe(2));
  it("empty lock tree => 2", () => {
    const lock = LOCK.replace(/"packages": \{[\s\S]*?\n {2}\}/, '"packages": {}');
    expect(project({ stdout: "{}", lock }).code).toBe(2);
  });
  it("unparseable lock => 2", () => expect(project({ stdout: "{}", lock: "{{{" }).code).toBe(2));
  it("lock not matching root manifest => 2", () => {
    const manifest = { ...MANIFEST, dependencies: { leftpad: "^2.0.0" } };
    expect(project({ stdout: "{}", manifest }).code).toBe(2);
  });
  it("manifest dependency missing from lock => 2", () => {
    const manifest = { ...MANIFEST, dependencies: { ...MANIFEST.dependencies, extra: "1.0.0" } };
    expect(project({ stdout: "{}", manifest }).code).toBe(2);
  });
  it("stale package-lock.json alongside => 2", () => {
    expect(project({ stdout: "{}", extraFiles: { "package-lock.json": "{}" } }).code).toBe(2);
  });

  const TARBALL_LOCK = LOCK.replace(
    '"tool": ["tool@2.0.0", "", {}, "sha512-bbb"],',
    '"tool": ["tool@2.0.0", "", {}, "sha512-bbb"],\n    "sheet": ["sheet@https://cdn.example/sheet-1.tgz", {}, "sha512-ccc"],',
  ).replace(
    '"tool": "2.0.0", },\n    },',
    '"tool": "2.0.0", },\n      "optionalDependencies": {},\n    },',
  );
  it("unreviewed tarball package => 2 (not silently skipped)", () => {
    const r = project({ stdout: "{}", lock: TARBALL_LOCK });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/UNREVIEWED non-registry package/);
  });
  it("reviewed tarball with exact resolution+integrity => 0 and listed UNSCANNED", () => {
    const reviewed = [
      {
        key: "sheet",
        resolution: "sheet@https://cdn.example/sheet-1.tgz",
        integrity: "sha512-ccc",
        reason: "fixture",
      },
    ];
    const r = project({
      stdout: "{}",
      lock: TARBALL_LOCK,
      extraFiles: { "scripts/supply-chain-unscanned.json": JSON.stringify(reviewed) },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/UNSCANNED \(reviewed/);
  });
  it("reviewed tarball whose integrity changed => 2", () => {
    const reviewed = [
      {
        key: "sheet",
        resolution: "sheet@https://cdn.example/sheet-1.tgz",
        integrity: "sha512-OLD",
      },
    ];
    expect(
      project({
        stdout: "{}",
        lock: TARBALL_LOCK,
        extraFiles: { "scripts/supply-chain-unscanned.json": JSON.stringify(reviewed) },
      }).code,
    ).toBe(2);
  });
});

describe("pure helpers", () => {
  it("evaluateAudit rejects non-object reports", () => {
    for (const s of ["[]", "null", "1", '"x"']) expect(evaluateAudit(s).code).toBe(2);
  });
  it("validateLock accepts the fixture", () => {
    expect(validateLock(LOCK, JSON.stringify(MANIFEST))).toMatchObject({
      packageCount: 2,
      nonRegistry: [],
    });
  });
});
