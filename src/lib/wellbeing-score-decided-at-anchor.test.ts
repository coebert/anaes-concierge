import "@/test/assert-utc-hook";
/**
 * Regression coverage for the `decided_at` anchor in `computeWellbeing`.
 *
 * The leave-driver filter for `rejected`/`cancelled` rows anchors on
 * `decided_at` when present and falls back to `start_date` otherwise
 * (see wellbeing-score.ts). These tests pin the boundary behaviour so
 * a refactor cannot silently swap the anchor, invert the fallback, or
 * regress on rows with a null/undefined `decided_at`.
 */
import { describe, expect, it } from "vitest";

import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

const STAFF_ID = "staff-1";
const NOW = new Date("2026-07-10T12:00:00Z");
const WINDOW_DAYS = 90;
// Window opens at NOW - 90 days = 2026-04-11 (inclusive by day-string
// comparison in inWin).
const IN_WINDOW_DAY = "2026-05-01";
const IN_WINDOW_TS = "2026-05-01T09:00:00Z";
const OUT_WINDOW_DAY = "2020-01-01";
const OUT_WINDOW_TS = "2020-01-01T09:00:00Z";

const BAD_STATUSES = ["rejected", "cancelled"] as const;

function makeRow(status: string, overrides: Partial<LeaveLite> = {}): LeaveLite {
  return {
    staff_id: STAFF_ID,
    status,
    type: "annual",
    start_date: "2026-06-01",
    end_date: "2026-06-05",
    ...overrides,
  };
}

function leaveValue(rows: LeaveLite[]) {
  const res = computeWellbeing({
    staffId: STAFF_ID,
    now: NOW,
    windowDays: WINDOW_DAYS,
    assignments: [],
    changes: [],
    leave: rows,
    exceptions: [],
  });
  const d = res.drivers.find((x) => x.key === "leave");
  expect(d).toBeDefined();
  return d!.value;
}

describe("computeWellbeing — decided_at anchor for rejected/cancelled leave", () => {
  describe.each(BAD_STATUSES)("%s rows", (status) => {
    it("uses decided_at (inside window) even when start_date is outside", () => {
      expect(
        leaveValue([
          makeRow(status, {
            start_date: OUT_WINDOW_DAY,
            end_date: OUT_WINDOW_DAY,
            decided_at: IN_WINDOW_TS,
          }),
        ]),
      ).toBe(1);
    });

    it("uses decided_at (outside window) even when start_date is inside", () => {
      expect(
        leaveValue([
          makeRow(status, {
            start_date: IN_WINDOW_DAY,
            end_date: IN_WINDOW_DAY,
            decided_at: OUT_WINDOW_TS,
          }),
        ]),
      ).toBe(0);
    });

    it("falls back to start_date when decided_at is null", () => {
      expect(
        leaveValue([
          makeRow(status, {
            start_date: IN_WINDOW_DAY,
            end_date: IN_WINDOW_DAY,
            decided_at: null,
          }),
        ]),
      ).toBe(1);
      expect(
        leaveValue([
          makeRow(status, {
            start_date: OUT_WINDOW_DAY,
            end_date: OUT_WINDOW_DAY,
            decided_at: null,
          }),
        ]),
      ).toBe(0);
    });

    it("falls back to start_date when decided_at is undefined (property omitted)", () => {
      expect(
        leaveValue([
          makeRow(status, { start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY }),
        ]),
      ).toBe(1);
      expect(
        leaveValue([
          makeRow(status, { start_date: OUT_WINDOW_DAY, end_date: OUT_WINDOW_DAY }),
        ]),
      ).toBe(0);
    });

    it("prefers decided_at over start_date when both are present (no accidental OR)", () => {
      // If the filter accidentally accepts a row when EITHER date is
      // in-window, this row would count. It must not.
      expect(
        leaveValue([
          makeRow(status, {
            start_date: IN_WINDOW_DAY,
            end_date: IN_WINDOW_DAY,
            decided_at: OUT_WINDOW_TS,
          }),
        ]),
      ).toBe(0);
      // Symmetric: start_date outside, decided_at inside → counts.
      expect(
        leaveValue([
          makeRow(status, {
            start_date: OUT_WINDOW_DAY,
            end_date: OUT_WINDOW_DAY,
            decided_at: IN_WINDOW_TS,
          }),
        ]),
      ).toBe(1);
    });

    it("slices decided_at to the day so a late-UTC timestamp still anchors correctly", () => {
      // decided_at includes a time component; the filter must slice to
      // yyyy-mm-dd. A timestamp on an in-window date should count even
      // when start_date is far outside the window.
      expect(
        leaveValue([
          makeRow(status, {
            start_date: OUT_WINDOW_DAY,
            end_date: OUT_WINDOW_DAY,
            decided_at: `${IN_WINDOW_DAY}T23:59:59Z`,
          }),
        ]),
      ).toBe(1);
    });
  });

  it("mixes anchors correctly across rows in one call", () => {
    // 3 rows should count: rejected-by-decided_at, cancelled-by-start_date,
    // rejected-by-start_date (no decided_at). 2 rows should drop: cancelled
    // with decided_at outside (start_date inside → must not rescue), and
    // an approved row (wrong status).
    const value = leaveValue([
      makeRow("rejected", {
        start_date: OUT_WINDOW_DAY,
        end_date: OUT_WINDOW_DAY,
        decided_at: IN_WINDOW_TS,
      }),
      makeRow("cancelled", {
        start_date: IN_WINDOW_DAY,
        end_date: IN_WINDOW_DAY,
        decided_at: null,
      }),
      makeRow("rejected", {
        start_date: IN_WINDOW_DAY,
        end_date: IN_WINDOW_DAY,
      }),
      makeRow("cancelled", {
        start_date: IN_WINDOW_DAY,
        end_date: IN_WINDOW_DAY,
        decided_at: OUT_WINDOW_TS,
      }),
      makeRow("approved", {
        start_date: IN_WINDOW_DAY,
        end_date: IN_WINDOW_DAY,
        decided_at: IN_WINDOW_TS,
      }),
    ]);
    expect(value).toBe(3);
  });
});
