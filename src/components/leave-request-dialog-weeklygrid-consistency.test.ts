/**
 * Consistency test: the LeaveRequestDialog's `buildImpactPreview`
 * (per-date "On leave" cells) must agree with the /api/chat
 * `weeklyGrid` labels produced by `buildCurrentPatternResponse` for
 * the SAME selected date range.
 *
 * "Agree" means:
 *   - every date/half the impact preview marks as changing to
 *     "On leave" corresponds to a weeklyGrid weekday-half that
 *     labels as "On leave" once the leave is applied (dominant
 *     bucket over the window)
 *   - halves the preview leaves as "—" (weekend or half-day skipped)
 *     correspond to weeklyGrid halves that keep their pre-leave
 *     dominant label (theatre, etc.)
 */
import { describe, it, expect } from "vitest";
import { buildImpactPreview } from "@/components/leave-request-dialog";
import {
  applyLeaveOverlay,
  buildCurrentPatternResponse,
  expandApprovedLeaveToAssignments,
  type LeaveRowLite,
} from "@/lib/staff-current-pattern";
import {
  LOCATION_LABELS,
  type AssignmentLite,
  type SessionLite,
  type SpecialtyLite,
  type TheatreLite,
} from "@/lib/staff-working-patterns";

const STAFF = { id: "s1", full_name: "Dr Consistency", grade: null };
const WINDOW_FROM = "2026-01-01";
const WINDOW_TO = "2026-03-31";
const WINDOW_DAYS = 90;

const theatresById = new Map<string, TheatreLite>([
  ["t-main", { id: "t-main", name: "Main 1", kind: "main" }],
]);
const sessionsById = new Map<string, SessionLite>([
  ["s-main", { id: "s-main", theatre_id: "t-main", specialty_id: null, is_non_sag: false }],
]);
const specialtiesById = new Map<string, SpecialtyLite>();

function theatre(date: string, half: "am" | "pm"): AssignmentLite {
  return {
    staff_id: STAFF.id,
    duty_type: "theatre",
    session_date: date,
    session: half,
    theatre_session_id: "s-main",
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};
const dowName = (iso: string): string => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return Object.entries(WEEKDAY_INDEX).find(([, i]) => i === dow)![0];
};

describe("Leave dialog impact preview vs /api/chat weeklyGrid — consistency", () => {
  // Three consecutive weeks with Mon–Fri AM+PM theatre.
  const WEEKS = [
    { mon: "2026-01-05", tue: "2026-01-06", wed: "2026-01-07", thu: "2026-01-08", fri: "2026-01-09" },
    { mon: "2026-01-12", tue: "2026-01-13", wed: "2026-01-14", thu: "2026-01-15", fri: "2026-01-16" },
    { mon: "2026-01-19", tue: "2026-01-20", wed: "2026-01-21", thu: "2026-01-22", fri: "2026-01-23" },
  ];
  const baseAssignments: AssignmentLite[] = WEEKS.flatMap((w) =>
    [w.mon, w.tue, w.wed, w.thu, w.fri].flatMap((d) => [theatre(d, "am"), theatre(d, "pm")]),
  );

  it("preview 'On leave' dates map to weeklyGrid 'On leave' weekday-halves — mid-week Mon-PM → Wed-AM leave", () => {
    // A leave range on week 2. The dialog's preview shows the
    // impact for THIS specific range; the weeklyGrid asks: if
    // this pattern REPEATED across the window, would this
    // weekday-half be dominantly 'leave'? To make them agree we
    // apply the SAME half-day-marked leave to every week and
    // verify the halves the preview flips to "On leave" are the
    // same halves the weeklyGrid ends up labelling "On leave".
    const previewStart = WEEKS[1].mon;
    const previewEnd = WEEKS[1].wed;
    const preview = buildImpactPreview(
      previewStart,
      previewEnd,
      "pm",
      "am",
      [], // no own conflicts — before = "Free" is fine for this consistency check
      true,
    );

    // Build a matching weeklyGrid: leave applied to every week's
    // Mon-PM → Wed-AM. That's what a "regular" pattern would be.
    const leaveRows: LeaveRowLite[] = WEEKS.map((w) => ({
      type: "annual",
      status: "approved",
      start_date: w.mon,
      end_date: w.wed,
      half_day_start: "pm",
      half_day_end: "am",
      reason: null,
      decision_notes: null,
    }));
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      leaveRows,
      WINDOW_FROM,
      WINDOW_TO,
    );
    const effective = applyLeaveOverlay(baseAssignments, overlay);
    const res = buildCurrentPatternResponse({
      profile: STAFF,
      windowDays: WINDOW_DAYS,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      assignments: effective,
      sessionsById,
      theatresById,
      specialtiesById,
    });

    const amRow = res.weeklyGrid.find((r) => r.session === "am")!;
    const pmRow = res.weeklyGrid.find((r) => r.session === "pm")!;
    const gridCell = (session: "am" | "pm", weekday: string) => {
      const row = session === "am" ? amRow : pmRow;
      const c = row.days.find((d) => d.weekday === weekday);
      if (!c) throw new Error(`missing weekly cell ${weekday} ${session}`);
      return c;
    };

    // For every row in the preview, cross-check the weeklyGrid.
    for (const row of preview) {
      const weekday = dowName(row.date);

      // Weekend cells — preview shows "—"; weeklyGrid has no weekend
      // columns, so nothing to compare.
      if (row.weekend) {
        expect(row.am.changed).toBe(false);
        expect(row.pm.changed).toBe(false);
        continue;
      }

      for (const half of ["am", "pm"] as const) {
        const cell = row[half];
        const grid = gridCell(half, weekday);
        if (cell.changed) {
          // Preview says this half becomes "On leave" → grid must
          // agree that this weekday-half is dominant "On leave".
          expect(cell.after).toBe("On leave");
          expect(grid.location, `${weekday} ${half}`).toBe(LOCATION_LABELS.leave);
        } else {
          // Preview leaves it untouched (skipped half-day or
          // weekend) — grid keeps its Main-theatres label.
          expect(grid.location, `${weekday} ${half}`).toBe(LOCATION_LABELS.main);
        }
      }
    }

    // Sanity: at least ONE preview cell was "changed" — otherwise
    // the test would trivially pass.
    expect(preview.some((r) => r.am.changed || r.pm.changed)).toBe(true);
  });

  it("preview 'On leave' dates map to weeklyGrid 'On leave' weekday-halves — Fri-PM → Mon-AM weekend boundary", () => {
    const previewStart = WEEKS[1].fri;
    const previewEnd = WEEKS[2].mon;
    const preview = buildImpactPreview(
      previewStart,
      previewEnd,
      "pm",
      "am",
      [],
      true,
    );

    const leaveRows: LeaveRowLite[] = WEEKS.slice(0, 2).map((_w, i) => ({
      type: "annual",
      status: "approved",
      start_date: WEEKS[i].fri,
      end_date: WEEKS[i + 1].mon,
      half_day_start: "pm",
      half_day_end: "am",
      reason: null,
      decision_notes: null,
    }));
    // Add a third boundary too so 'leave' is the dominant bucket
    // for Fri-PM and Mon-AM (need ≥ minRecurrence).
    leaveRows.push({
      type: "annual",
      status: "approved",
      start_date: "2026-01-23", // Fri wk3
      end_date: "2026-01-26",   // Mon after wk3
      half_day_start: "pm",
      half_day_end: "am",
      reason: null,
      decision_notes: null,
    });
    // Include theatre for the Mon 2026-01-26 so it counts as a
    // real week-day observation.
    const extendedAssignments = [
      ...baseAssignments,
      theatre("2026-01-26", "am"),
      theatre("2026-01-26", "pm"),
    ];
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      leaveRows,
      WINDOW_FROM,
      WINDOW_TO,
    );
    const effective = applyLeaveOverlay(extendedAssignments, overlay);
    const res = buildCurrentPatternResponse({
      profile: STAFF,
      windowDays: WINDOW_DAYS,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      assignments: effective,
      sessionsById,
      theatresById,
      specialtiesById,
    });
    const amRow = res.weeklyGrid.find((r) => r.session === "am")!;
    const pmRow = res.weeklyGrid.find((r) => r.session === "pm")!;
    const gridCell = (session: "am" | "pm", weekday: string) => {
      const row = session === "am" ? amRow : pmRow;
      return row.days.find((d) => d.weekday === weekday)!;
    };

    for (const row of preview) {
      const weekday = dowName(row.date);
      if (row.weekend) {
        expect(row.am.changed).toBe(false);
        expect(row.pm.changed).toBe(false);
        continue;
      }
      for (const half of ["am", "pm"] as const) {
        const cell = row[half];
        const grid = gridCell(half, weekday);
        if (cell.changed) {
          expect(cell.after).toBe("On leave");
          expect(grid.location, `${weekday} ${half}`).toBe(LOCATION_LABELS.leave);
        } else {
          // Fri-AM & Mon-PM must remain Main theatres in both.
          expect(grid.location, `${weekday} ${half}`).toBe(LOCATION_LABELS.main);
        }
      }
    }

    // Preview must have flipped Fri PM and Mon AM specifically.
    const fri = preview.find((r) => r.date === previewStart)!;
    const mon = preview.find((r) => r.date === previewEnd)!;
    expect(fri.am.changed).toBe(false);
    expect(fri.pm.changed).toBe(true);
    expect(mon.am.changed).toBe(true);
    expect(mon.pm.changed).toBe(false);
  });
});
