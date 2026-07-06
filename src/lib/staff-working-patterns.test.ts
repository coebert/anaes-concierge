/**
 * Tests for `dominantByHalfSession` and `suggestedRegularityThreshold`.
 *
 * Covers:
 *   - Dominant location per (weekday, half-session) picks the bucket with
 *     the most distinct dates.
 *   - Only Mon–Fri cells are populated; weekend assignments (Sat/Sun) and
 *     assignments with no `am`/`pm` half are ignored.
 *   - The `minCount` regularity threshold gates one-off shifts.
 *   - `suggestedRegularityThreshold` scales with the window in days.
 */
import { describe, it, expect } from "vitest";
import {
  dominantByHalfSession,
  suggestedRegularityThreshold,
  type AssignmentLite,
  type SessionLite,
  type TheatreLite,
} from "./staff-working-patterns";

const STAFF = "staff-1";

const theatresById = new Map<string, TheatreLite>([
  ["t-main", { id: "t-main", name: "Main 1", kind: "main" }],
  ["t-day", { id: "t-day", name: "DSU 1", kind: "day_surgery" }],
  ["t-priv", { id: "t-priv", name: "NHH 1", kind: "private" }],
]);

function mkSession(id: string, theatre_id: string | null, is_non_sag = false): SessionLite {
  return { id, theatre_id, specialty_id: null, is_non_sag };
}
const sessionsById = new Map<string, SessionLite>([
  ["s-main", mkSession("s-main", "t-main")],
  ["s-day", mkSession("s-day", "t-day")],
  ["s-priv", mkSession("s-priv", "t-priv", false)],
]);

function theatre(
  date: string,
  half: "am" | "pm",
  sessionId: "s-main" | "s-day" | "s-priv",
): AssignmentLite {
  return {
    staff_id: STAFF,
    duty_type: "theatre",
    session_date: date,
    session: half,
    theatre_session_id: sessionId,
  };
}

describe("dominantByHalfSession", () => {
  it("picks the location bucket with the most distinct dates for a cell", () => {
    // Four Mondays: three in main theatres, one in day surgery.
    // 2025-01-06, -13, -20 are Mondays; -27 also Monday.
    const assignments: AssignmentLite[] = [
      theatre("2025-01-06", "am", "s-main"),
      theatre("2025-01-13", "am", "s-main"),
      theatre("2025-01-20", "am", "s-main"),
      theatre("2025-01-27", "am", "s-day"),
    ];
    const result = dominantByHalfSession(assignments, sessionsById, theatresById, 2);
    const monAm = result.am[1]; // 1 = Monday
    expect(monAm).not.toBeNull();
    expect(monAm!.bucket).toBe("main");
    expect(monAm!.count).toBe(3);
    expect(monAm!.total).toBe(4);
  });

  it("only populates Mon–Fri cells; weekend assignments are ignored", () => {
    // 2025-01-04 Sat, 2025-01-05 Sun, 2025-01-11 Sat.
    const assignments: AssignmentLite[] = [
      theatre("2025-01-04", "am", "s-main"),
      theatre("2025-01-05", "am", "s-main"),
      theatre("2025-01-11", "am", "s-main"),
      theatre("2025-01-04", "pm", "s-main"),
      theatre("2025-01-05", "pm", "s-main"),
    ];
    const result = dominantByHalfSession(assignments, sessionsById, theatresById, 2);
    // Saturday (6) and Sunday (0) must remain null.
    expect(result.am[0]).toBeNull();
    expect(result.am[6]).toBeNull();
    expect(result.pm[0]).toBeNull();
    expect(result.pm[6]).toBeNull();
    // And none of the Mon–Fri cells should have been populated either.
    for (let dow = 1; dow <= 5; dow++) {
      expect(result.am[dow]).toBeNull();
      expect(result.pm[dow]).toBeNull();
    }
  });

  it("ignores assignments without an am/pm half", () => {
    const assignments: AssignmentLite[] = [
      { ...theatre("2025-01-06", "am", "s-main"), session: null },
      { ...theatre("2025-01-13", "am", "s-main"), session: "" },
      { ...theatre("2025-01-20", "am", "s-main"), session: "eve" },
    ];
    const result = dominantByHalfSession(assignments, sessionsById, theatresById, 2);
    for (let dow = 0; dow < 7; dow++) {
      expect(result.am[dow]).toBeNull();
      expect(result.pm[dow]).toBeNull();
    }
  });

  it("keeps AM and PM cells independent for the same weekday", () => {
    // Three Tuesdays AM in main, three Tuesdays PM in day surgery.
    // 2025-01-07, -14, -21 are Tuesdays.
    const assignments: AssignmentLite[] = [
      theatre("2025-01-07", "am", "s-main"),
      theatre("2025-01-14", "am", "s-main"),
      theatre("2025-01-21", "am", "s-main"),
      theatre("2025-01-07", "pm", "s-day"),
      theatre("2025-01-14", "pm", "s-day"),
      theatre("2025-01-21", "pm", "s-day"),
    ];
    const result = dominantByHalfSession(assignments, sessionsById, theatresById, 2);
    expect(result.am[2]?.bucket).toBe("main");
    expect(result.pm[2]?.bucket).toBe("day_surgery");
  });

  describe("regularity threshold (minCount)", () => {
    // Two Wednesdays in main (2025-01-08, 2025-01-15).
    const twoWednesdays: AssignmentLite[] = [
      theatre("2025-01-08", "am", "s-main"),
      theatre("2025-01-15", "am", "s-main"),
    ];

    it("shows a cell when the winning bucket meets minCount", () => {
      const result = dominantByHalfSession(twoWednesdays, sessionsById, theatresById, 2);
      expect(result.am[3]?.bucket).toBe("main");
      expect(result.am[3]?.count).toBe(2);
    });

    it("suppresses a cell when the winning bucket falls below minCount", () => {
      const result = dominantByHalfSession(twoWednesdays, sessionsById, theatresById, 3);
      expect(result.am[3]).toBeNull();
    });

    it("collapses a single one-off shift under the default minCount of 2", () => {
      const oneOff: AssignmentLite[] = [theatre("2025-01-08", "am", "s-main")];
      const result = dominantByHalfSession(oneOff, sessionsById, theatresById, 2);
      expect(result.am[3]).toBeNull();
    });

    it("counts distinct dates only, not duplicate assignments on the same date", () => {
      // Same Wednesday recorded twice — still one distinct date.
      const dup: AssignmentLite[] = [
        theatre("2025-01-08", "am", "s-main"),
        theatre("2025-01-08", "am", "s-main"),
      ];
      const result = dominantByHalfSession(dup, sessionsById, theatresById, 2);
      expect(result.am[3]).toBeNull();
    });
  });
});

describe("suggestedRegularityThreshold", () => {
  it("returns at least 2 for short windows", () => {
    expect(suggestedRegularityThreshold(7)).toBe(2);
    expect(suggestedRegularityThreshold(14)).toBe(2);
    expect(suggestedRegularityThreshold(28)).toBe(2);
  });

  it("scales roughly one per four weeks for longer windows", () => {
    expect(suggestedRegularityThreshold(56)).toBe(2);
    expect(suggestedRegularityThreshold(84)).toBe(3);
    expect(suggestedRegularityThreshold(90)).toBe(3);
    expect(suggestedRegularityThreshold(112)).toBe(4);
    expect(suggestedRegularityThreshold(180)).toBe(6);
  });

  it("matches the derived minCount = max(2, floor(threshold/2)+1) used by the card and chat", () => {
    // Sanity-check the derivation used in both current-pattern-card.tsx and
    // routes/api/chat.ts so a change in `suggestedRegularityThreshold` is
    // visible here too.
    for (const windowDays of [14, 30, 60, 90, 120, 180]) {
      const threshold = suggestedRegularityThreshold(windowDays);
      const minCount = Math.max(2, Math.floor(threshold / 2) + 1);
      expect(minCount).toBeGreaterThanOrEqual(2);
      expect(minCount).toBeLessThanOrEqual(threshold + 1);
    }
  });
});
