/**
 * Additional unit tests for `applyLeaveOverlay` on multi-day, half-day
 * leave that spans a week boundary (Fri PM → next-Mon AM).
 *
 * `staff-current-pattern-week-boundary.test.ts` already covers the
 * happy path for Fri/Mon-only fixtures. This suite fills in the harder
 * cases:
 *
 *   1. Every half-session in the Fri..Mon range has a theatre list —
 *      only the four half-sessions covered by the overlay (Fri PM +
 *      Sat AM/PM + Sun AM/PM + Mon AM) are replaced; Fri AM and Mon PM
 *      keep their theatre `duty_type`.
 *   2. Rota commitments OUTSIDE the leave span (Thu, Tue) are never
 *      touched by `applyLeaveOverlay`, even when the leave brackets
 *      them chronologically.
 *   3. Two consecutive Fri→Mon leave spans on adjacent weekends
 *      preserve Fri AM and Mon PM on BOTH weekends independently.
 *   4. Non-conflicting halves — e.g. a duty_type='spa' block on Fri AM
 *      or an ICU block on Mon PM — survive the overlay untouched
 *      (only the exact overlapping half-session is replaced).
 */
import { describe, it, expect } from "vitest";
import {
  applyLeaveOverlay,
  expandApprovedLeaveToAssignments,
  type LeaveRowLite,
} from "./staff-current-pattern";
import type { AssignmentLite } from "./staff-working-patterns";

const STAFF_ID = "s1";
const WINDOW_FROM = "2026-01-01";
const WINDOW_TO = "2026-03-31";

function asn(
  date: string,
  half: "am" | "pm",
  duty: AssignmentLite["duty_type"] = "theatre",
): AssignmentLite {
  return {
    staff_id: STAFF_ID,
    duty_type: duty,
    session_date: date,
    session: half,
    theatre_session_id: duty === "theatre" ? "ts-main" : null,
  };
}

function leave(
  over: Partial<LeaveRowLite> & Pick<LeaveRowLite, "start_date" | "end_date">,
): LeaveRowLite {
  return {
    type: "annual",
    status: "approved",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
    ...over,
  };
}

/**
 * Convenience: (date|half) -> duty_type after overlay, for compact
 * assertion. Keys we never expect back are omitted.
 */
function dutyMap(rows: AssignmentLite[]): Record<string, string | null> {
  const m: Record<string, string | null> = {};
  for (const r of rows) m[`${r.session_date}|${r.session}`] = r.duty_type;
  return m;
}

describe("applyLeaveOverlay — multi-day week-boundary half-day leave", () => {
  const SPAN = leave({
    start_date: "2026-01-09", // Fri
    end_date: "2026-01-12",   // Mon
    half_day_start: "pm",
    half_day_end: "am",
  });

  it("replaces exactly the 6 covered half-sessions and leaves Fri AM + Mon PM intact", () => {
    const overlay = expandApprovedLeaveToAssignments(
      STAFF_ID,
      [SPAN],
      WINDOW_FROM,
      WINDOW_TO,
    );
    const baseline: AssignmentLite[] = [
      asn("2026-01-09", "am"),
      asn("2026-01-09", "pm"),
      asn("2026-01-10", "am"),
      asn("2026-01-10", "pm"),
      asn("2026-01-11", "am"),
      asn("2026-01-11", "pm"),
      asn("2026-01-12", "am"),
      asn("2026-01-12", "pm"),
    ];
    const merged = applyLeaveOverlay(baseline, overlay);
    expect(dutyMap(merged)).toEqual({
      "2026-01-09|am": "theatre", // survives
      "2026-01-09|pm": "leave",
      "2026-01-10|am": "leave",
      "2026-01-10|pm": "leave",
      "2026-01-11|am": "leave",
      "2026-01-11|pm": "leave",
      "2026-01-12|am": "leave",
      "2026-01-12|pm": "theatre", // survives
    });
    // Same total number of rows — overlay swaps, never duplicates.
    expect(merged).toHaveLength(baseline.length);
  });

  it("does not touch commitments outside the leave span (Thu before, Tue after)", () => {
    const overlay = expandApprovedLeaveToAssignments(
      STAFF_ID,
      [SPAN],
      WINDOW_FROM,
      WINDOW_TO,
    );
    const baseline: AssignmentLite[] = [
      asn("2026-01-08", "am"), // Thu (before)
      asn("2026-01-08", "pm"),
      asn("2026-01-09", "am"), // Fri (survives)
      asn("2026-01-12", "pm"), // Mon (survives)
      asn("2026-01-13", "am"), // Tue (after)
      asn("2026-01-13", "pm"),
    ];
    const merged = applyLeaveOverlay(baseline, overlay);
    const map = dutyMap(merged);
    expect(map["2026-01-08|am"]).toBe("theatre");
    expect(map["2026-01-08|pm"]).toBe("theatre");
    expect(map["2026-01-13|am"]).toBe("theatre");
    expect(map["2026-01-13|pm"]).toBe("theatre");
    // And the "brackets" survive too.
    expect(map["2026-01-09|am"]).toBe("theatre");
    expect(map["2026-01-12|pm"]).toBe("theatre");
    // No stray leave rows outside the span.
    for (const r of merged) {
      if (r.duty_type === "leave") {
        expect(r.session_date >= "2026-01-09" && r.session_date <= "2026-01-12").toBe(true);
      }
    }
  });

  it("two consecutive Fri→Mon spans preserve Fri AM + Mon PM independently on each weekend", () => {
    const spans = [
      leave({
        start_date: "2026-01-09",
        end_date: "2026-01-12",
        half_day_start: "pm",
        half_day_end: "am",
      }),
      leave({
        start_date: "2026-01-16",
        end_date: "2026-01-19",
        half_day_start: "pm",
        half_day_end: "am",
      }),
    ];
    const overlay = expandApprovedLeaveToAssignments(
      STAFF_ID,
      spans,
      WINDOW_FROM,
      WINDOW_TO,
    );
    const baseline: AssignmentLite[] = [
      // week 1
      asn("2026-01-09", "am"),
      asn("2026-01-09", "pm"),
      asn("2026-01-12", "am"),
      asn("2026-01-12", "pm"),
      // week 2
      asn("2026-01-16", "am"),
      asn("2026-01-16", "pm"),
      asn("2026-01-19", "am"),
      asn("2026-01-19", "pm"),
    ];
    const merged = dutyMap(applyLeaveOverlay(baseline, overlay));
    for (const [friAmKey, friPmKey, monAmKey, monPmKey] of [
      ["2026-01-09|am", "2026-01-09|pm", "2026-01-12|am", "2026-01-12|pm"],
      ["2026-01-16|am", "2026-01-16|pm", "2026-01-19|am", "2026-01-19|pm"],
    ]) {
      expect(merged[friAmKey]).toBe("theatre");
      expect(merged[friPmKey]).toBe("leave");
      expect(merged[monAmKey]).toBe("leave");
      expect(merged[monPmKey]).toBe("theatre");
    }
  });

  it("survives non-theatre duty types on the intact halves (spa on Fri AM, icu on Mon PM)", () => {
    const overlay = expandApprovedLeaveToAssignments(
      STAFF_ID,
      [SPAN],
      WINDOW_FROM,
      WINDOW_TO,
    );
    const baseline: AssignmentLite[] = [
      asn("2026-01-09", "am", "spa"),
      asn("2026-01-09", "pm"),
      asn("2026-01-12", "am"),
      asn("2026-01-12", "pm", "icu_ct2_plus"),
    ];
    const merged = dutyMap(applyLeaveOverlay(baseline, overlay));
    expect(merged["2026-01-09|am"]).toBe("spa"); // untouched
    expect(merged["2026-01-09|pm"]).toBe("leave");
    expect(merged["2026-01-12|am"]).toBe("leave");
    expect(merged["2026-01-12|pm"]).toBe("icu_ct2_plus"); // untouched
  });
});
