import "@/test/assert-utc-hook";
/**
 * Enum-conformance test for the wellbeing-score engine.
 *
 * The DB `leave_requests.status` column is a Postgres enum with exactly
 * four values: `pending | approved | rejected | cancelled`. The score
 * engine has one status-driven code path (the "leave" driver) plus a
 * date-anchor rule (`decided_at` → fall back to `start_date`) that reads
 * status too. This suite pins down, for every enum value, that:
 *
 *   1. Only `rejected` and `cancelled` contribute to the leave driver.
 *   2. `pending` and `approved` are ignored (they aren't "bad leave").
 *   3. The legacy `"denied"` string — the pre-fix spelling that leaked
 *      through code and tests — is NOT recognised. Any occurrence in the
 *      source file OR any behavioural match on that string is a bug.
 *   4. `rejected` and `cancelled` are treated identically: same count
 *      per row, same normalisation cap (3), same weight (0.10), same
 *      driver key/label wording.
 *   5. The `decided_at` anchor is applied to BOTH `rejected` and
 *      `cancelled` rows — a row decided inside the window counts even
 *      when its `start_date` is outside, and a row decided outside the
 *      window is dropped even when its `start_date` is inside.
 *
 * If any wellbeing code path grows a new status check (retry logic,
 * partial cancellation, etc.), extend the ENUM_VALUES table and add a
 * case here so the DB enum stays the single source of truth.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

// The exact set of values the DB enum permits — mirrored here so a test
// failure names the value that regressed.
const ENUM_VALUES = ["pending", "approved", "rejected", "cancelled"] as const;
type EnumStatus = (typeof ENUM_VALUES)[number];

// Statuses that MUST contribute to the leave driver.
const BAD_STATUSES: readonly EnumStatus[] = ["rejected", "cancelled"];
// Statuses that MUST NOT contribute.
const NEUTRAL_STATUSES: readonly EnumStatus[] = ["pending", "approved"];

const STAFF_ID = "staff-1";
const NOW = new Date("2026-07-10T12:00:00Z");
const WINDOW_DAYS = 90;

function makeLeaveRow(
  status: string,
  overrides: Partial<LeaveLite> = {},
): LeaveLite {
  return {
    staff_id: STAFF_ID,
    status,
    type: "annual",
    start_date: "2026-06-01",
    end_date: "2026-06-05",
    ...overrides,
  };
}

function runWithLeave(rows: LeaveLite[]) {
  return computeWellbeing({
    staffId: STAFF_ID,
    now: NOW,
    windowDays: WINDOW_DAYS,
    assignments: [],
    changes: [],
    leave: rows,
    exceptions: [],
  });
}

function leaveDriver(result: ReturnType<typeof runWithLeave>) {
  const d = result.drivers.find((x) => x.key === "leave");
  expect(d, "wellbeing result is missing the 'leave' driver").toBeDefined();
  return d!;
}

describe("wellbeing-score — leave status enum conformance", () => {
  it("has no lingering 'denied' references in the source file", () => {
    // Static guard: catches a regression where the DB enum shifts and
    // stale code slips back in. Cheap, hard to game.
    const src = readFileSync(
      fileURLToPath(
        new URL("../features/wellbeing/wellbeing-score.ts", import.meta.url),
      ),
      "utf8",
    );
    // The word "denied" as a bare token — status literals ("denied"),
    // property matches (=== "denied"), or comment references — is a bug.
    // Substrings inside larger words are fine (there are none today).
    expect(
      /\bdenied\b/i.test(src),
      "wellbeing-score.ts still references the legacy 'denied' status; " +
        "the DB enum is pending | approved | rejected | cancelled.",
    ).toBe(false);
  });

  it.each(BAD_STATUSES)(
    "counts a single %s row in the leave driver",
    (status) => {
      const driver = leaveDriver(runWithLeave([makeLeaveRow(status)]));
      expect(driver.value).toBe(1);
      expect(driver.weight).toBe(0.10);
      // capAt = 3 → 1/3 normalised.
      expect(driver.normalised).toBeCloseTo(1 / 3, 10);
      expect(driver.label).toMatch(/rejected\/cancelled/);
    },
  );

  it.each(NEUTRAL_STATUSES)(
    "ignores %s rows in the leave driver",
    (status) => {
      const driver = leaveDriver(runWithLeave([makeLeaveRow(status)]));
      expect(driver.value).toBe(0);
      expect(driver.normalised).toBe(0);
    },
  );

  it("does NOT treat the legacy 'denied' value as bad leave", () => {
    // Behavioural mirror of the source-file guard: if the filter ever
    // regresses to `l.status === "denied"`, this row would count.
    const driver = leaveDriver(
      runWithLeave([makeLeaveRow("denied" as unknown as string)]),
    );
    expect(driver.value).toBe(0);
    expect(driver.normalised).toBe(0);
  });

  it("treats rejected and cancelled identically (same count, weight, normalisation)", () => {
    const rejected = leaveDriver(
      runWithLeave([
        makeLeaveRow("rejected", { start_date: "2026-06-01", end_date: "2026-06-01" }),
        makeLeaveRow("rejected", { start_date: "2026-06-10", end_date: "2026-06-10" }),
        makeLeaveRow("rejected", { start_date: "2026-06-20", end_date: "2026-06-20" }),
      ]),
    );
    const cancelled = leaveDriver(
      runWithLeave([
        makeLeaveRow("cancelled", { start_date: "2026-06-01", end_date: "2026-06-01" }),
        makeLeaveRow("cancelled", { start_date: "2026-06-10", end_date: "2026-06-10" }),
        makeLeaveRow("cancelled", { start_date: "2026-06-20", end_date: "2026-06-20" }),
      ]),
    );
    expect(rejected.value).toBe(cancelled.value);
    expect(rejected.normalised).toBe(cancelled.normalised);
    expect(rejected.weight).toBe(cancelled.weight);
    // Three rows at capAt=3 → fully weighted.
    expect(rejected.normalised).toBe(1);
    expect(rejected.weight).toBe(0.10);
  });

  it("applies the exact 0.10 leave weight to the composite score", () => {
    // Three bad-leave rows fully saturate the driver (normalised = 1).
    // Every other driver is 0, so the composite harm is exactly the
    // leave weight and the score drops by weight * 100 = 10 points.
    const baseline = runWithLeave([]);
    const saturated = runWithLeave([
      makeLeaveRow("rejected", { start_date: "2026-06-01", end_date: "2026-06-01" }),
      makeLeaveRow("cancelled", { start_date: "2026-06-10", end_date: "2026-06-10" }),
      makeLeaveRow("rejected", { start_date: "2026-06-20", end_date: "2026-06-20" }),
    ]);
    expect(baseline.score).toBe(100);
    expect(saturated.score).toBe(90);
  });

  describe("decided_at anchor applies to rejected AND cancelled", () => {
    // start_date is deliberately outside the 90-day window; only the
    // decided_at value (inside the window) can rescue it.
    const OUTSIDE = { start_date: "2020-01-01", end_date: "2020-01-05" };
    // ...and vice versa: start_date inside the window, decided_at outside.
    const INSIDE = { start_date: "2026-06-01", end_date: "2026-06-05" };
    const decidedInside = "2026-06-15T09:00:00Z";
    const decidedOutside = "2020-02-01T09:00:00Z";

    it.each(BAD_STATUSES)(
      "counts a %s row whose start_date is outside the window but decided_at is inside",
      (status) => {
        const driver = leaveDriver(
          runWithLeave([
            makeLeaveRow(status, { ...OUTSIDE, decided_at: decidedInside }),
          ]),
        );
        expect(driver.value).toBe(1);
      },
    );

    it.each(BAD_STATUSES)(
      "drops a %s row whose decided_at is outside the window even if start_date is inside",
      (status) => {
        const driver = leaveDriver(
          runWithLeave([
            makeLeaveRow(status, { ...INSIDE, decided_at: decidedOutside }),
          ]),
        );
        expect(driver.value).toBe(0);
      },
    );

    it.each(BAD_STATUSES)(
      "falls back to start_date when decided_at is null/undefined for %s",
      (status) => {
        const nullAnchor = leaveDriver(
          runWithLeave([makeLeaveRow(status, { ...INSIDE, decided_at: null })]),
        );
        const undefAnchor = leaveDriver(
          runWithLeave([makeLeaveRow(status, INSIDE)]),
        );
        expect(nullAnchor.value).toBe(1);
        expect(undefAnchor.value).toBe(1);
      },
    );
  });

  it("covers every DB enum value exactly once across BAD_STATUSES + NEUTRAL_STATUSES", () => {
    // Meta-check: if the enum grows and this table isn't updated, the
    // partition above stops being exhaustive and the suite silently
    // stops asserting on the new value.
    const covered = new Set<EnumStatus>([...BAD_STATUSES, ...NEUTRAL_STATUSES]);
    expect(covered.size).toBe(ENUM_VALUES.length);
    for (const v of ENUM_VALUES) {
      expect(covered.has(v), `enum value ${v} is not covered by any partition`).toBe(true);
    }
  });
});
