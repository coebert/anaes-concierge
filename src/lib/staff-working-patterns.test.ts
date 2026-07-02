import { describe, it, expect } from "vitest";
import {
  computeConsultantPattern,
  type AssignmentLite,
  type SessionLite,
  type TheatreLite,
} from "./staff-working-patterns";

/**
 * Regression tests for the consultant working-pattern engine.
 *
 * Focused on irregular / edge-shape inputs so future changes can't
 * silently mis-align the Working / SPA / On-call rows on the Working
 * patterns page:
 *
 *   - Weekend assignments must NEVER appear in any weekday output
 *     array (the UI only renders Mon–Fri; weekend leakage would break
 *     the 5-cell grid layout).
 *   - AM-only and PM-only irregular shifts must land in the matching
 *     half-day bucket only — never both.
 *   - Below-threshold ad-hoc cover must be dropped so it can't
 *     phantom-fill a column.
 *   - Assignments with missing / null half-session flags must not
 *     crash and must not silently populate AM or PM.
 */

const NO_THEATRES = new Map<string, TheatreLite>();
const NO_SESSIONS = new Map<string, SessionLite>();

function make(
  date: string,
  half: "am" | "pm" | null,
  duty: string = "theatre",
): AssignmentLite {
  return {
    staff_id: "s1",
    duty_type: duty,
    session_date: date,
    session: half,
    theatre_session_id: null,
  };
}

describe("computeConsultantPattern — irregular data safety", () => {
  it("never emits weekend weekdays even when data contains Sat/Sun shifts", () => {
    // 2026-01-03 = Sat, 2026-01-04 = Sun (repeated 4x to exceed threshold).
    const weekend: AssignmentLite[] = [
      make("2026-01-03", "am"),
      make("2026-01-04", "pm"),
      make("2026-01-10", "am"),
      make("2026-01-11", "pm"),
      make("2026-01-17", "am"),
      make("2026-01-18", "pm"),
      make("2026-01-24", "am"),
      make("2026-01-25", "pm"),
    ];
    const p = computeConsultantPattern(
      weekend,
      NO_SESSIONS,
      NO_THEATRES,
      { regularityThreshold: 2 },
    );
    for (const arr of [
      p.workingWeekdays,
      p.amWorkingWeekdays,
      p.pmWorkingWeekdays,
      p.privateWeekdays,
      p.onCallWeekdays,
      p.spaAmWeekdays,
      p.spaPmWeekdays,
    ]) {
      expect(arr.every((d) => d >= 1 && d <= 5)).toBe(true);
    }
    // Weekend duty is not "not working" — totals count it, but rendering skips it.
    expect(p.totalWorkingSessions).toBe(8);
  });

  it("classifies AM-only Tuesdays as AM working, not PM", () => {
    const amOnly: AssignmentLite[] = [
      make("2026-01-06", "am"), // Tue
      make("2026-01-13", "am"),
      make("2026-01-20", "am"),
      make("2026-01-27", "am"),
    ];
    const p = computeConsultantPattern(amOnly, NO_SESSIONS, NO_THEATRES, {
      regularityThreshold: 2,
    });
    expect(p.amWorkingWeekdays).toEqual([2]);
    expect(p.pmWorkingWeekdays).toEqual([]);
    expect(p.workingWeekdays).toEqual([2]);
  });

  it("classifies PM-only Thursdays as PM working, not AM", () => {
    const pmOnly: AssignmentLite[] = [
      make("2026-01-08", "pm"), // Thu
      make("2026-01-15", "pm"),
      make("2026-01-22", "pm"),
      make("2026-01-29", "pm"),
    ];
    const p = computeConsultantPattern(pmOnly, NO_SESSIONS, NO_THEATRES, {
      regularityThreshold: 2,
    });
    expect(p.pmWorkingWeekdays).toEqual([4]);
    expect(p.amWorkingWeekdays).toEqual([]);
  });

  it("separates AM SPA from PM SPA on the same weekday", () => {
    // Mondays: SPA in AM. Wednesdays: SPA in PM.
    const spa: AssignmentLite[] = [
      make("2026-01-05", "am", "spa"), // Mon
      make("2026-01-12", "am", "spa"),
      make("2026-01-07", "pm", "spa"), // Wed
      make("2026-01-14", "pm", "spa"),
    ];
    const p = computeConsultantPattern(spa, NO_SESSIONS, NO_THEATRES, {
      regularityThreshold: 3, // spaThreshold => max(2, floor(3/2)+1) = 2
    });
    expect(p.spaAmWeekdays).toEqual([1]);
    expect(p.spaPmWeekdays).toEqual([3]);
  });

  it("drops below-threshold ad-hoc cover so the grid isn't padded", () => {
    // One-off Friday PM cover — must not count as regular.
    const adhoc: AssignmentLite[] = [make("2026-01-09", "pm")];
    const p = computeConsultantPattern(adhoc, NO_SESSIONS, NO_THEATRES, {
      regularityThreshold: 2,
    });
    expect(p.workingWeekdays).toEqual([]);
    expect(p.pmWorkingWeekdays).toEqual([]);
    expect(p.totalWorkingSessions).toBe(1);
  });

  it("handles null / unknown session flag without leaking into AM or PM", () => {
    // duty logged with no session half specified — must count toward the
    // overall day but neither half-day bucket.
    const noHalf: AssignmentLite[] = [
      make("2026-01-06", null), // Tue
      make("2026-01-13", null),
      make("2026-01-20", null),
    ];
    const p = computeConsultantPattern(noHalf, NO_SESSIONS, NO_THEATRES, {
      regularityThreshold: 2,
    });
    expect(p.workingWeekdays).toEqual([2]);
    expect(p.amWorkingWeekdays).toEqual([]);
    expect(p.pmWorkingWeekdays).toEqual([]);
  });

  it("keeps on-call weekdays separate from working weekdays", () => {
    // Consultant is on-call Friday evenings — non-working duty.
    const oncall: AssignmentLite[] = [
      make("2026-01-09", "pm", "general_consultant_oncall"),
      make("2026-01-16", "pm", "general_consultant_oncall"),
      make("2026-01-23", "pm", "general_consultant_oncall"),
    ];
    const p = computeConsultantPattern(oncall, NO_SESSIONS, NO_THEATRES, {
      regularityThreshold: 2,
    });
    expect(p.onCallWeekdays).toEqual([5]);
    expect(p.workingWeekdays).toEqual([]);
    expect(p.amWorkingWeekdays).toEqual([]);
    expect(p.pmWorkingWeekdays).toEqual([]);
    expect(p.onCallType).toBe("theatre");
  });
});
