import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * End-to-end audit pipeline test.
 *
 * Exercises `computeRobustness` over a multi-day window with a realistic
 * blend of:
 *  - active and inactive (legacy NHH) theatres
 *  - AM and PM half-day lists across the whole working week
 *  - consultants, senior trainees (ST6/ST7) and SAS staff
 *  - approved leave overlapping part of the window
 *  - SPA, admin, on-call and emergency theatre sessions
 *
 * Assertion: for every half-day where every ACTIVE theatre list is staffed
 * by a solo-capable clinician, the consultant shortfall (`unfilled`) is 0
 * and `risk` is not `"shortfall"` — across every day in the range.
 */

type Row = Record<string, unknown>;

interface Fixture {
  profiles: Row[];
  leave_requests: Row[];
  theatre_sessions: Row[];
  rota_assignments: Row[];
  duty_type_pool_rules: Row[];
  specialties: Row[];
  theatres: Row[];
}

const fixture: Fixture = {
  profiles: [],
  leave_requests: [],
  theatre_sessions: [],
  rota_assignments: [],
  duty_type_pool_rules: [
    { duty_type: "theatre", category: "clinical_list" },
    { duty_type: "spa", category: "flex" },
    { duty_type: "admin", category: "excluded" },
    { duty_type: "on_call", category: "excluded" },
  ],
  specialties: [],
  theatres: [],
};

function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.order = () => c;
  c.range = () => c;
  c.in = (col: string, vals: unknown[]) => {
    filters.push((r) => vals.includes(r[col]));
    return c;
  };
  c.eq = (col: string, val: unknown) => {
    filters.push((r) => r[col] === val);
    return c;
  };
  c.lte = (col: string, val: unknown) => {
    filters.push((r) => (r[col] as string) <= (val as string));
    return c;
  };
  c.gte = (col: string, val: unknown) => {
    filters.push((r) => (r[col] as string) >= (val as string));
    return c;
  };
  const resolve = () => {
    const rows = (fixture as unknown as Record<string, Row[]>)[table] ?? [];
    const filtered = filters.length
      ? rows.filter((r) => filters.every((f) => f(r)))
      : rows;
    return Promise.resolve({ data: filtered, error: null });
  };
  c.then = (ok: (v: { data: Row[]; error: null }) => unknown) =>
    resolve().then(ok);
  return c;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (t: string) => chain(t) },
}));

import { computeRobustness } from "./robustness";

// Monday → Friday of an arbitrary week.
const WEEK: string[] = [
  "2026-06-08", // Mon
  "2026-06-09", // Tue
  "2026-06-10", // Wed
  "2026-06-11", // Thu
  "2026-06-12", // Fri
];
const RANGE_START = WEEK[0];
const RANGE_END = WEEK[WEEK.length - 1];

const T_ACTIVE_1 = "t-active-1";
const T_ACTIVE_2 = "t-active-2";
const T_ACTIVE_3 = "t-active-3";
const T_LEGACY = "t-legacy-nhh";

// Specialty used to mark emergency / CEPOD theatre lists.
const SPEC_EMERGENCY = "spec-emergency";

beforeEach(() => {
  fixture.leave_requests = [];
  fixture.theatre_sessions = [];
  fixture.rota_assignments = [];
  fixture.theatres = [];
  fixture.profiles = [];
  fixture.specialties = [];
});

function seedBaselineFixture() {
  fixture.theatres = [
    { id: T_ACTIVE_1, active: true },
    { id: T_ACTIVE_2, active: true },
    { id: T_ACTIVE_3, active: true },
    { id: T_LEGACY, active: false },
  ];
  fixture.specialties = [
    { id: SPEC_EMERGENCY, name: "Emergency / CEPOD" },
  ];

  // Staff pool — plenty of solo-capable clinicians plus support grades.
  fixture.profiles = [
    // 6 consultants
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `c${i + 1}`,
      grade: "consultant",
      training_level: null,
      ltft_days_off: [],
      active: true,
    })),
    // 2 senior (solo-capable) trainees
    { id: "st6-1", grade: "trainee", training_level: "ST6", ltft_days_off: [], active: true },
    { id: "st7-1", grade: "trainee", training_level: "ST7", ltft_days_off: [], active: true },
    // 2 SAS doctors (do not count toward solo cover but appear in the pool)
    { id: "sas-1", grade: "sas", training_level: null, ltft_days_off: [], active: true },
    { id: "sas-2", grade: "sas", training_level: null, ltft_days_off: [], active: true },
  ];

  // One consultant on a week-long approved leave (extra realism).
  fixture.leave_requests = [
    { staff_id: "c6", start_date: RANGE_START, end_date: RANGE_END, status: "approved" },
  ];

  // Build the theatre schedule and the consultant cover for every weekday.
  // 3 active theatres × AM + PM = 6 lists/day, all staffed.
  // Plus 1 phantom legacy NHH list/day (must be filtered out).
  // Plus 1 emergency CEPOD list/day (must not be counted as demand).
  const sessions: Row[] = [];
  const assignments: Row[] = [];

  WEEK.forEach((date, dayIdx) => {
    const activeTheatres = [T_ACTIVE_1, T_ACTIVE_2, T_ACTIVE_3];
    (["am", "pm"] as const).forEach((half, halfIdx) => {
      activeTheatres.forEach((theatreId, tIdx) => {
        const tsId = `ts-${date}-${half}-${tIdx}`;
        sessions.push({
          id: tsId,
          session_date: date,
          session: half,
          specialty_id: null,
          surgical_consultant: null,
          theatre_id: theatreId,
        });
        // Rotate solo-capable staff (5 consultants on-rota + 2 seniors).
        const soloPool = ["c1", "c2", "c3", "c4", "c5", "st6-1", "st7-1"];
        const staffId =
          soloPool[(dayIdx * 6 + halfIdx * 3 + tIdx) % soloPool.length];
        assignments.push({
          staff_id: staffId,
          session_date: date,
          session: half,
          duty_type: "theatre",
          theatre_session_id: tsId,
        });
      });

      // Phantom legacy NHH list — unstaffed. Must be filtered.
      sessions.push({
        id: `ts-${date}-${half}-legacy`,
        session_date: date,
        session: half,
        specialty_id: null,
        surgical_consultant: null,
        theatre_id: T_LEGACY,
      });

      // Emergency CEPOD list — covered by on-call, not by the daytime pool.
      sessions.push({
        id: `ts-${date}-${half}-cepod`,
        session_date: date,
        session: half,
        specialty_id: SPEC_EMERGENCY,
        surgical_consultant: "Emergency on-call",
        theatre_id: T_ACTIVE_1,
      });
    });

    // Add some non-list duties to exercise the duty_type_pool_rules filters.
    assignments.push(
      { staff_id: "sas-1", session_date: date, session: "am", duty_type: "spa", theatre_session_id: null },
      { staff_id: "sas-2", session_date: date, session: "pm", duty_type: "admin", theatre_session_id: null },
    );
  });

  fixture.theatre_sessions = sessions;
  fixture.rota_assignments = assignments;
}

describe("computeRobustness — end-to-end pipeline", () => {
  it("reports zero consultant shortfall for every half-day across the week when all active lists are staffed", async () => {
    seedBaselineFixture();

    const { days, totalStaffByGrade } = await computeRobustness(
      RANGE_START,
      RANGE_END,
    );

    // Sanity: pipeline produced one DayCapacity per weekday in range.
    expect(days.map((d) => d.date)).toEqual(WEEK);
    expect(totalStaffByGrade.consultant).toBe(6);

    for (const day of days) {
      for (const half of ["am", "pm"] as const) {
        const cap = day[half];

        // Demand counts only the 3 active theatres — legacy phantom and
        // emergency CEPOD lists must be filtered out of `required`.
        expect(cap.required, `${day.date} ${half} required`).toBe(3);

        // Every active list is staffed by a solo-capable clinician.
        expect(cap.unfilled, `${day.date} ${half} unfilled`).toBe(0);

        // Headroom is non-negative and risk is never a shortfall.
        expect(
          cap.headroom,
          `${day.date} ${half} headroom`,
        ).toBeGreaterThanOrEqual(0);
        expect(cap.risk, `${day.date} ${half} risk`).not.toBe("shortfall");
        expect(cap.risk, `${day.date} ${half} risk`).not.toBe("spa_required");
      }
    }
  });

  it("flags a shortfall when an active list goes unfilled (negative control)", async () => {
    seedBaselineFixture();
    // Remove every assignment for Wednesday AM on theatre 2 → genuine gap.
    const wed = WEEK[2];
    fixture.rota_assignments = (fixture.rota_assignments as Row[]).filter(
      (a) =>
        !(
          a.session_date === wed &&
          a.session === "am" &&
          a.theatre_session_id === `ts-${wed}-am-1`
        ),
    );
    // And shrink the pool so the gap cannot be absorbed by spare capacity.
    fixture.profiles = (fixture.profiles as Row[]).filter((p) =>
      ["c1", "c2", "st6-1", "st7-1"].includes(p.id as string),
    );
    // Reassign Wed AM lists 0 and 2 to the remaining consultants so only
    // list 1 is actually unfilled.
    fixture.rota_assignments = (fixture.rota_assignments as Row[]).filter(
      (a) => !(a.session_date === wed && a.session === "am"),
    );
    fixture.rota_assignments.push(
      { staff_id: "c1", session_date: wed, session: "am", duty_type: "theatre", theatre_session_id: `ts-${wed}-am-0` },
      { staff_id: "c2", session_date: wed, session: "am", duty_type: "theatre", theatre_session_id: `ts-${wed}-am-2` },
    );

    const { days } = await computeRobustness(RANGE_START, RANGE_END);
    const wedDay = days.find((d) => d.date === wed)!;
    expect(wedDay.am.required).toBe(3);
    expect(wedDay.am.unfilled).toBe(1);
    expect(wedDay.am.risk).toBe("shortfall");

    // Other days remain healthy — proves the pipeline isolates the gap.
    for (const day of days.filter((d) => d.date !== wed)) {
      expect(day.am.unfilled, `${day.date} am`).toBe(0);
      expect(day.pm.unfilled, `${day.date} pm`).toBe(0);
      expect(day.am.risk, `${day.date} am risk`).not.toBe("shortfall");
      expect(day.pm.risk, `${day.date} pm risk`).not.toBe("shortfall");
    }
  });
});
