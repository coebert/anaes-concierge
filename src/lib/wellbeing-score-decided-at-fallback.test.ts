import "@/test/assert-utc-hook";
/**
 * Focused unit tests for the `decided_at` fallback in `computeWellbeing`'s
 * rejected/cancelled leave driver. The engine anchors on `decided_at` when
 * present and falls back to `start_date` otherwise:
 *
 *   const anchor = l.decided_at ? l.decided_at.slice(0, 10) : l.start_date;
 *
 * Broader anchor rules live in `wellbeing-score-decided-at-anchor.test.ts`.
 * This file pins the fallback specifically — the null / undefined / empty
 * / other falsy inputs, the interaction with other filters (staff_id,
 * status), and boundary behaviour around the 90-day window.
 *
 * A regression that changes the fallback (e.g. `l.decided_at ?? l.start_date`
 * accepting `""` as valid, or falling back to `end_date`, or dropping rows
 * with no decision timestamp) would fail here.
 */
import { describe, expect, it } from "vitest";

import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

const STAFF_ID = "staff-fallback";
const OTHER_STAFF = "staff-other";
const NOW = new Date("2026-07-10T12:00:00Z");
const WINDOW_DAYS = 90;
// Window = (NOW - 90d, NOW] by ms comparison; day-string comparison uses
// `<day>T00:00:00Z`. With NOW = 2026-07-10T12:00:00Z, the earliest day
// whose 00:00:00Z timestamp is >= windowStart is 2026-04-12.
const WINDOW_START_DAY = "2026-04-12";
const IN_WINDOW_DAY = "2026-05-01";
const JUST_BEFORE_WINDOW = "2026-04-11";
const OUT_WINDOW_DAY = "2020-01-01";

function makeRow(status: string, overrides: Partial<LeaveLite> = {}): LeaveLite {
  return {
    staff_id: STAFF_ID,
    status,
    type: "annual",
    start_date: IN_WINDOW_DAY,
    end_date: IN_WINDOW_DAY,
    ...overrides,
  };
}

function driver(rows: LeaveLite[]) {
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
  expect(d, "leave driver missing from computeWellbeing output").toBeDefined();
  return d!;
}

function leaveValue(rows: LeaveLite[]) {
  return driver(rows).value;
}

describe("computeWellbeing — decided_at fallback (null / missing / falsy)", () => {
  describe.each(["rejected", "cancelled"] as const)("%s row", (status) => {
    it("null decided_at + in-window start_date → counts via start_date", () => {
      expect(
        leaveValue([makeRow(status, { decided_at: null, start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY })]),
      ).toBe(1);
    });

    it("null decided_at + out-of-window start_date → does NOT count", () => {
      // Prove the fallback path still honours the window filter — it is
      // not a "count whenever decided_at is null" free pass.
      expect(
        leaveValue([makeRow(status, { decided_at: null, start_date: OUT_WINDOW_DAY, end_date: OUT_WINDOW_DAY })]),
      ).toBe(0);
    });

    it("undefined decided_at (property omitted) + in-window start_date → counts", () => {
      const row = makeRow(status, { start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY });
      // Confirm the property really is absent — a future refactor that
      // added a `decided_at: null` default would still be a fallback path
      // and we want to keep the "no property" case tested distinctly.
      expect(Object.prototype.hasOwnProperty.call(row, "decided_at")).toBe(false);
      expect(leaveValue([row])).toBe(1);
    });

    it("undefined decided_at (property omitted) + out-of-window start_date → does NOT count", () => {
      expect(
        leaveValue([makeRow(status, { start_date: OUT_WINDOW_DAY, end_date: OUT_WINDOW_DAY })]),
      ).toBe(0);
    });

    it('empty-string decided_at is falsy → falls back to start_date', () => {
      // The engine uses truthiness (`l.decided_at ? ... : l.start_date`),
      // so `""` must behave the same as null/undefined. A refactor to
      // `l.decided_at ?? l.start_date` would break this — `""` is not
      // nullish and would slice to `""`, then compare against the
      // window as a "0000" date and silently drop the row.
      expect(
        leaveValue([
          makeRow(status, {
            decided_at: "" as unknown as string,
            start_date: IN_WINDOW_DAY,
            end_date: IN_WINDOW_DAY,
          }),
        ]),
      ).toBe(1);
      expect(
        leaveValue([
          makeRow(status, {
            decided_at: "" as unknown as string,
            start_date: OUT_WINDOW_DAY,
            end_date: OUT_WINDOW_DAY,
          }),
        ]),
      ).toBe(0);
    });

    it("null decided_at + start_date on the exact window-start day → counts (inclusive)", () => {
      // Boundary day. `inWin` uses `>=` on the parsed timestamp; the
      // fallback path must inherit that inclusivity.
      expect(
        leaveValue([
          makeRow(status, {
            decided_at: null,
            start_date: WINDOW_START_DAY,
            end_date: WINDOW_START_DAY,
          }),
        ]),
      ).toBe(1);
    });

    it("null decided_at + start_date the day BEFORE the window → does NOT count", () => {
      expect(
        leaveValue([
          makeRow(status, {
            decided_at: null,
            start_date: JUST_BEFORE_WINDOW,
            end_date: JUST_BEFORE_WINDOW,
          }),
        ]),
      ).toBe(0);
    });

    it("null decided_at does not fall back to end_date", () => {
      // Guard against a plausible-looking refactor that swaps the
      // fallback anchor to end_date. Here start_date is OUT and end_date
      // is IN — the row must NOT count.
      expect(
        leaveValue([
          makeRow(status, {
            decided_at: null,
            start_date: OUT_WINDOW_DAY,
            end_date: IN_WINDOW_DAY,
          }),
        ]),
      ).toBe(0);
    });
  });

  it("null decided_at on the WRONG staff id is still excluded (staff filter before anchor)", () => {
    // A regression that reordered filters (checked anchor before
    // staff_id) could accidentally leak other people's rows into this
    // staff's driver when decided_at was null.
    expect(
      leaveValue([
        makeRow("cancelled", {
          staff_id: OTHER_STAFF,
          decided_at: null,
          start_date: IN_WINDOW_DAY,
          end_date: IN_WINDOW_DAY,
        }),
      ]),
    ).toBe(0);
  });

  it("null decided_at on a NON rejected/cancelled row is still excluded (status filter before anchor)", () => {
    // Approved with a null decision — must not count regardless of the
    // fallback path. The status filter runs before the anchor check.
    expect(
      leaveValue([
        makeRow("approved", {
          decided_at: null,
          start_date: IN_WINDOW_DAY,
          end_date: IN_WINDOW_DAY,
        }),
      ]),
    ).toBe(0);
    // Same for a status the engine doesn't know about.
    expect(
      leaveValue([
        makeRow("pending", {
          decided_at: null,
          start_date: IN_WINDOW_DAY,
          end_date: IN_WINDOW_DAY,
        }),
      ]),
    ).toBe(0);
  });

  it("aggregates multiple null-decided_at rows correctly (each counted independently)", () => {
    // Three in-window fallback rows, one out-of-window fallback row.
    // Only the three in-window should count.
    const rows: LeaveLite[] = [
      makeRow("cancelled", { decided_at: null, start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY }),
      makeRow("rejected", { decided_at: null, start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY }),
      makeRow("cancelled", { decided_at: null, start_date: WINDOW_START_DAY, end_date: WINDOW_START_DAY }),
      makeRow("rejected", { decided_at: null, start_date: OUT_WINDOW_DAY, end_date: OUT_WINDOW_DAY }),
    ];
    expect(leaveValue(rows)).toBe(3);
  });

  it("driver label reflects the fallback-anchored count", () => {
    // Downstream UI reads the label directly — pin the format so a
    // regression that split "rejected/cancelled leave" across two
    // separate drivers would surface here.
    const d = driver([
      makeRow("cancelled", { decided_at: null, start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY }),
      makeRow("rejected", { decided_at: null, start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY }),
    ]);
    expect(d.label).toBe("2 rejected/cancelled leave");
  });

  it("mixed rows: fallback and decided_at rows coexist in one call", () => {
    // 4 rows should count:
    //   • rejected with in-window decided_at (anchor path)
    //   • cancelled with null decided_at + in-window start_date (fallback path)
    //   • cancelled with undefined decided_at + in-window start_date (fallback path)
    //   • rejected with empty-string decided_at + in-window start_date (falsy → fallback)
    // 3 rows should drop:
    //   • cancelled with in-window start_date but out-of-window decided_at
    //     (anchor wins; must not be OR'd)
    //   • rejected with null decided_at + out-of-window start_date
    //   • approved with in-window decided_at (wrong status)
    const rows: LeaveLite[] = [
      makeRow("rejected", {
        start_date: OUT_WINDOW_DAY,
        end_date: OUT_WINDOW_DAY,
        decided_at: `${IN_WINDOW_DAY}T09:00:00Z`,
      }),
      makeRow("cancelled", { decided_at: null, start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY }),
      makeRow("cancelled", { start_date: IN_WINDOW_DAY, end_date: IN_WINDOW_DAY }),
      makeRow("rejected", {
        decided_at: "" as unknown as string,
        start_date: IN_WINDOW_DAY,
        end_date: IN_WINDOW_DAY,
      }),
      makeRow("cancelled", {
        start_date: IN_WINDOW_DAY,
        end_date: IN_WINDOW_DAY,
        decided_at: `${OUT_WINDOW_DAY}T09:00:00Z`,
      }),
      makeRow("rejected", { decided_at: null, start_date: OUT_WINDOW_DAY, end_date: OUT_WINDOW_DAY }),
      makeRow("approved", {
        decided_at: `${IN_WINDOW_DAY}T09:00:00Z`,
      }),
    ];
    expect(leaveValue(rows)).toBe(4);
  });
});
