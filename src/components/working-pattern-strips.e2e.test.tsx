// @vitest-environment jsdom
/**
 * End-to-end regression for the "SPA / on-call weekday share" feature on
 * the staff working-patterns page.
 *
 * Drives the real pipeline used by the route:
 *
 *   raw rota_assignments rows
 *     → computeConsultantPattern(...)        (src/lib/staff-working-patterns.ts)
 *     → <SpaStrip /> and <WeekdayStrip />    (src/components/working-pattern-strips.tsx)
 *
 * A known 12-week rota is generated for a single consultant with an
 * intentionally *uneven* SPA and on-call distribution, and the test asserts
 * both the highlighted cells and the exact percentage / tooltip breakdown
 * rendered in the card. Any regression in the counting logic, the
 * regularity filter, the totals, or the tooltip template will fail here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

import {
  SpaStrip,
  WeekdayStrip,
} from "@/components/working-pattern-strips";
import {
  computeConsultantPattern,
  type AssignmentLite,
  type SessionLite,
  type TheatreLite,
} from "@/lib/staff-working-patterns";

afterEach(() => cleanup());

// --- Rota fixture -------------------------------------------------------
//
// Window: 12 consecutive weeks starting Monday 2026-01-05 (a Monday in UTC).
// Weekly rhythm for the consultant under test:
//
//   Mon  → on-call every OTHER week  (weeks 0,2,4,6,8,10)  → 6 sessions
//   Tue  → theatre AM+PM every week (irrelevant filler; not on-call, not SPA)
//   Wed  → SPA AM every week                                → 12 sessions
//   Thu  → on-call every THIRD week (weeks 0,3,6,9)          → 4 sessions
//   Fri  → SPA PM every OTHER week (weeks 1,3,5,7,9,11)      → 6 sessions
//
// Expected consultant pattern (regularityThreshold = 3, SPA threshold = 2):
//   spaAmWeekdays        = [3]                (Wed)
//   spaPmWeekdays        = [5]                (Fri)
//   onCallWeekdays       = [1, 4]             (Mon, Thu)
//   totalSpaSessions     = 12 + 6 = 18
//   totalOnCallSessions  = 6 + 4  = 10
//   spaCountsByWeekday   [Wed]=12 [Fri]=6
//   onCallCountsByWeekday[Mon]=6  [Thu]=4
//
// Percentage assertions:
//   SPA:      Wed 12/18 = 67%,  Fri 6/18  = 33%
//   On-call:  Mon 6/10  = 60%,  Thu 4/10  = 40%

const STAFF_ID = "consultant-1";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildFixture(): AssignmentLite[] {
  const out: AssignmentLite[] = [];
  const WEEK0_MON = "2026-01-05"; // UTC Monday
  for (let week = 0; week < 12; week++) {
    const mon = addDays(WEEK0_MON, week * 7);
    const tue = addDays(mon, 1);
    const wed = addDays(mon, 2);
    const thu = addDays(mon, 3);
    const fri = addDays(mon, 4);

    // Mon — theatre on-call every other week
    if (week % 2 === 0) {
      out.push({
        staff_id: STAFF_ID,
        duty_type: "general_consultant_oncall",
        session_date: mon,
        session: "am",
        theatre_session_id: null,
      });
    }

    // Tue — normal theatre AM + PM (filler; not SPA, not on-call)
    for (const half of ["am", "pm"] as const) {
      out.push({
        staff_id: STAFF_ID,
        duty_type: "theatre",
        session_date: tue,
        session: half,
        theatre_session_id: null,
      });
    }

    // Wed — SPA AM every week
    out.push({
      staff_id: STAFF_ID,
      duty_type: "spa",
      session_date: wed,
      session: "am",
      theatre_session_id: null,
    });

    // Thu — theatre on-call every 3rd week
    if (week % 3 === 0) {
      out.push({
        staff_id: STAFF_ID,
        duty_type: "general_consultant_oncall",
        session_date: thu,
        session: "am",
        theatre_session_id: null,
      });
    }

    // Fri — SPA PM every other week (odd-numbered weeks)
    if (week % 2 === 1) {
      out.push({
        staff_id: STAFF_ID,
        duty_type: "spa",
        session_date: fri,
        session: "pm",
        theatre_session_id: null,
      });
    }
  }
  return out;
}

describe("staff working-patterns e2e — SPA/on-call weekday share", () => {
  const assignments = buildFixture();
  const sessions = new Map<string, SessionLite>();
  const theatres = new Map<string, TheatreLite>();
  const pattern = computeConsultantPattern(assignments, sessions, theatres, {
    regularityThreshold: 3,
  });

  it("computes the expected regular weekdays and totals from the fixture", () => {
    // Sanity-check the pipeline BEFORE the UI — if any of these fail the
    // rendering assertions below would be meaningless.
    expect(pattern.spaAmWeekdays).toEqual([3]);
    expect(pattern.spaPmWeekdays).toEqual([5]);
    expect(pattern.onCallWeekdays).toEqual([1, 4]);
    expect(pattern.totalSpaSessions).toBe(18);
    expect(pattern.totalOnCallSessions).toBe(10);
    expect(pattern.spaCountsByWeekday[3]).toBe(12); // Wed
    expect(pattern.spaCountsByWeekday[5]).toBe(6);  // Fri
    expect(pattern.onCallCountsByWeekday[1]).toBe(6); // Mon
    expect(pattern.onCallCountsByWeekday[4]).toBe(4); // Thu
  });

  it("renders the correct SPA weekday share % on each highlighted SPA cell", () => {
    render(
      <SpaStrip
        amDays={pattern.spaAmWeekdays}
        pmDays={pattern.spaPmWeekdays}
        countsByWeekday={pattern.spaCountsByWeekday}
        totalSessions={pattern.totalSpaSessions}
      />,
    );

    // Wed = AM SPA, 12/18 = 67%
    const wed = screen.getByTestId("spa-cell-3");
    expect(wed.textContent).toContain("AM");
    expect(screen.getByTestId("spa-pct-3").textContent).toBe("67%");

    // Fri = PM SPA, 6/18 = 33%
    const fri = screen.getByTestId("spa-cell-5");
    expect(fri.textContent).toContain("PM");
    expect(screen.getByTestId("spa-pct-5").textContent).toBe("33%");

    // Non-SPA weekdays: no % rendered
    for (const d of [1, 2, 4]) {
      expect(screen.queryByTestId(`spa-pct-${d}`)).toBeNull();
    }
  });

  it("renders the correct SPA tooltip breakdown (count of total, percentage)", () => {
    render(
      <SpaStrip
        amDays={pattern.spaAmWeekdays}
        pmDays={pattern.spaPmWeekdays}
        countsByWeekday={pattern.spaCountsByWeekday}
        totalSessions={pattern.totalSpaSessions}
      />,
    );
    expect(screen.getByTestId("spa-cell-3").getAttribute("title")).toBe(
      "Wed · SPA AM · 12 of 18 SPA sessions (67%)",
    );
    expect(screen.getByTestId("spa-cell-5").getAttribute("title")).toBe(
      "Fri · SPA PM · 6 of 18 SPA sessions (33%)",
    );
    // Inactive weekday tooltip should NOT include the SPA breakdown.
    expect(screen.getByTestId("spa-cell-2").getAttribute("title")).toBe("Tue");
  });

  it("renders the correct on-call weekday share % on each highlighted cell", () => {
    render(
      <WeekdayStrip
        label="On-call"
        tone="amber"
        highlighted={pattern.onCallWeekdays}
        countsByWeekday={pattern.onCallCountsByWeekday}
        totalSessions={pattern.totalOnCallSessions}
      />,
    );
    // Mon 6/10 = 60%, Thu 4/10 = 40%
    expect(screen.getByTestId("weekday-pct-1").textContent).toBe("60%");
    expect(screen.getByTestId("weekday-pct-4").textContent).toBe("40%");
    for (const d of [2, 3, 5]) {
      expect(screen.queryByTestId(`weekday-pct-${d}`)).toBeNull();
    }
  });

  it("renders the correct on-call tooltip breakdown", () => {
    render(
      <WeekdayStrip
        label="On-call"
        tone="amber"
        highlighted={pattern.onCallWeekdays}
        countsByWeekday={pattern.onCallCountsByWeekday}
        totalSessions={pattern.totalOnCallSessions}
      />,
    );
    expect(screen.getByTestId("weekday-cell-1").getAttribute("title")).toBe(
      "Mon · 6 of 10 on-call sessions (60%)",
    );
    expect(screen.getByTestId("weekday-cell-4").getAttribute("title")).toBe(
      "Thu · 4 of 10 on-call sessions (40%)",
    );
    // Non-highlighted weekday: tooltip is just the day label.
    expect(screen.getByTestId("weekday-cell-3").getAttribute("title")).toBe(
      "Wed",
    );
  });
});
