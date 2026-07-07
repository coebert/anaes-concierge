import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Guardrail test for the DD/MM/YYYY ESLint policy in `eslint.config.js`.
 *
 * The rule bans locale-default `toLocaleDateString()` / `new Date().toLocaleString()`
 * / `new Intl.DateTimeFormat()` for date rendering so British users see
 * DD/MM/YYYY consistently. This test writes a temp file containing each
 * banned pattern, runs ESLint against it, and asserts the rule fires.
 *
 * If a future refactor accidentally drops the rule from the config, this
 * test fails immediately — cheaper than discovering the drift by eye months
 * later when someone lands a `new Date(x).toLocaleString()` in the UI.
 */

const FIXTURE = `/* eslint-disable prettier/prettier */
// toLocaleDateString — banned
const a = new Date().toLocaleDateString();
// new Date(...).toLocaleString — banned
const b = new Date("2026-05-26").toLocaleString();
// toLocaleString with an explicit locale — banned for dates
const c = new Date().toLocaleString("en-GB");
// Intl.DateTimeFormat — banned
const d = new Intl.DateTimeFormat("en-GB", { year: "numeric" });
export { a, b, c, d };
`;

function runEslintOn(filePath: string) {
  const res = spawnSync(
    "bunx",
    ["eslint", "--format", "json", "--no-inline-config", filePath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  // ESLint exits 1 when there are errors; stdout still contains the JSON report.
  const parsed = JSON.parse(res.stdout || "[]") as Array<{
    messages: Array<{ ruleId: string | null; message: string }>;
  }>;
  return parsed[0]?.messages ?? [];
}

describe("eslint: no locale-default date formatting", () => {
  it("flags every banned date-format pattern", () => {
    // Fixture lives under src/ so the file matches the config's `files` glob.
    const dir = mkdtempSync(join(process.cwd(), "src/.eslint-datefmt-"));
    const file = join(dir, "fixture.ts");
    writeFileSync(file, FIXTURE, "utf8");
    try {
      const messages = runEslintOn(file);
      const restricted = messages.filter(
        (m) => m.ruleId === "no-restricted-syntax",
      );

      // Four banned constructs in the fixture — the rule must catch all of them.
      // (The `.toLocaleString("en-GB")` line trips two selectors: the generic
      // "locale-string date" one AND the `new Date(...).toLocaleString` one.
      // Either way, every banned line produces at least one error.)
      const lines = new Set(
        restricted
          .map((m) => (m as unknown as { line?: number }).line)
          .filter((n): n is number => typeof n === "number"),
      );
      expect(lines.size).toBeGreaterThanOrEqual(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not flag DD/MM/YYYY helper usage from @/lib/utils", () => {
    const dir = mkdtempSync(join(process.cwd(), "src/.eslint-datefmt-ok-"));
    const file = join(dir, "fixture.ts");
    writeFileSync(
      file,
      `import { formatDateGB, formatDateTimeGB } from "@/lib/utils";
export const a = formatDateGB("2026-05-26");
export const b = formatDateTimeGB(new Date());
`,
      "utf8",
    );
    try {
      const messages = runEslintOn(file);
      const restricted = messages.filter(
        (m) => m.ruleId === "no-restricted-syntax",
      );
      expect(restricted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
