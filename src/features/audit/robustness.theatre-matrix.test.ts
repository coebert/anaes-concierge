import { describe, it, expect, vi, beforeEach } from "vitest";

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
  ],
  specialties: [],
  theatres: [],
};

function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.lte = () => c;
  c.gte = () => c;
  c.in = () => c;
  c.order = () => c;
  c.range = () => c;
  c.eq = (col: string, val: unknown) => {
    filters.push((r) => r[col] === val);
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

const DATE = "2026-06-08"; // Monday

beforeEach(() => {
  fixture.leave_requests = [];
  fixture.theatre_sessions = [];
  fixture.rota_assignments = [];
  fixture.theatres = [];
  fixture.profiles = [];
});

/**
 * Matrix of AM/PM × active/inactive theatre combinations.
 *
 * Each row enumerates one theatre_sessions row by:
 *  - session ("am" | "pm")
 *  - theatreActive (true → counted as demand, false → must be filtered out)
 *  - filled (true → a consultant is rostered onto it)
 *
 * The expected required/unfilled per half-day is derived purely from the
 * ACTIVE rows (legacy NHH-style inactive theatre rows must contribute 0).
 */
interface MatrixCase {
  name: string;
  rows: Array<{ session: "am" | "pm"; theatreActive: boolean; filled: boolean }>;
  expected: {
    am: { required: number; unfilled: number; shortfall: boolean };
    pm: { required: number; unfilled: number; shortfall: boolean };
  };
}

const cases: MatrixCase[] = [
  {
    name: "all active lists staffed, no legacy rows",
    rows: [
      { session: "am", theatreActive: true, filled: true },
      { session: "am", theatreActive: true, filled: true },
      { session: "pm", theatreActive: true, filled: true },
      { session: "pm", theatreActive: true, filled: true },
    ],
    expected: {
      am: { required: 2, unfilled: 0, shortfall: false },
      pm: { required: 2, unfilled: 0, shortfall: false },
    },
  },
  {
    name: "AM legacy phantom unstaffed, all active staffed → no shortfall",
    rows: [
      { session: "am", theatreActive: true, filled: true },
      { session: "am", theatreActive: true, filled: true },
      { session: "am", theatreActive: false, filled: false }, // legacy NHH AM
      { session: "pm", theatreActive: true, filled: true },
    ],
    expected: {
      am: { required: 2, unfilled: 0, shortfall: false },
      pm: { required: 1, unfilled: 0, shortfall: false },
    },
  },
  {
    name: "PM legacy phantom unstaffed, all active staffed → no shortfall",
    rows: [
      { session: "am", theatreActive: true, filled: true },
      { session: "pm", theatreActive: true, filled: true },
      { session: "pm", theatreActive: false, filled: false }, // legacy NHH PM
    ],
    expected: {
      am: { required: 1, unfilled: 0, shortfall: false },
      pm: { required: 1, unfilled: 0, shortfall: false },
    },
  },
  {
    name: "AM+PM legacy phantoms both unstaffed, all active staffed → no shortfall",
    rows: [
      { session: "am", theatreActive: true, filled: true },
      { session: "am", theatreActive: false, filled: false },
      { session: "pm", theatreActive: true, filled: true },
      { session: "pm", theatreActive: false, filled: false },
    ],
    expected: {
      am: { required: 1, unfilled: 0, shortfall: false },
      pm: { required: 1, unfilled: 0, shortfall: false },
    },
  },
  {
    name: "active AM list unfilled with legacy AM phantom present → AM shortfall (control)",
    // Single consultant pool sized to cover only the one filled list, so the
    // genuine gap on the second active AM list is a real shortfall and the
    // legacy phantom must not be conflated with it.
    rows: [
      { session: "am", theatreActive: true, filled: true },
      { session: "am", theatreActive: true, filled: false }, // real gap
      { session: "am", theatreActive: false, filled: false }, // legacy noise
    ],
    expected: {
      am: { required: 2, unfilled: 1, shortfall: true },
      pm: { required: 0, unfilled: 0, shortfall: false },
    },
  },
  {
    name: "active PM list unfilled with legacy PM phantom present → PM shortfall (control)",
    rows: [
      { session: "pm", theatreActive: true, filled: true },
      { session: "pm", theatreActive: true, filled: false }, // real gap
      { session: "pm", theatreActive: false, filled: false }, // legacy noise
    ],
    expected: {
      am: { required: 0, unfilled: 0, shortfall: false },
      pm: { required: 2, unfilled: 1, shortfall: true },
    },
  },
];


describe("computeRobustness — AM/PM × active/inactive theatre matrix", () => {
  for (const tc of cases) {
    it(tc.name, async () => {
      // Build theatres (dedupe by stable id per active flag).
      const activeTheatreId = "t-active";
      const activeTheatreId2 = "t-active-2";
      const legacyTheatreId = "t-legacy";
      fixture.theatres = [
        { id: activeTheatreId, active: true },
        { id: activeTheatreId2, active: true },
        { id: legacyTheatreId, active: false },
      ];

      // Allocate enough consultants to cover every "filled" row.
      const filledCount = tc.rows.filter((r) => r.filled).length;
      fixture.profiles = Array.from({ length: Math.max(filledCount, 1) }).map(
        (_, i) => ({
          id: `c${i + 1}`,
          grade: "consultant",
          training_level: null,
          ltft_days_off: [],
          active: true,
        }),
      );

      // Distribute active rows across the two active theatres so each
      // active half-day list maps to a distinct theatre_id (mirrors prod).
      let activeAmIdx = 0;
      let activePmIdx = 0;
      const theatreSessions: Row[] = [];
      const assignments: Row[] = [];
      let consultantCursor = 0;

      tc.rows.forEach((r, idx) => {
        const tsId = `ts-${idx}`;
        let theatreId: string;
        if (!r.theatreActive) {
          theatreId = legacyTheatreId;
        } else if (r.session === "am") {
          theatreId = activeAmIdx++ % 2 === 0 ? activeTheatreId : activeTheatreId2;
        } else {
          theatreId = activePmIdx++ % 2 === 0 ? activeTheatreId : activeTheatreId2;
        }
        theatreSessions.push({
          id: tsId,
          session_date: DATE,
          session: r.session,
          specialty_id: null,
          surgical_consultant: null,
          theatre_id: theatreId,
        });
        if (r.filled) {
          assignments.push({
            staff_id: `c${++consultantCursor}`,
            session_date: DATE,
            session: r.session,
            duty_type: "theatre",
            theatre_session_id: tsId,
          });
        }
      });
      fixture.theatre_sessions = theatreSessions;
      fixture.rota_assignments = assignments;

      const { days } = await computeRobustness(DATE, DATE);
      const am = days[0].am;
      const pm = days[0].pm;

      expect(am.required, "AM required").toBe(tc.expected.am.required);
      expect(am.unfilled, "AM unfilled").toBe(tc.expected.am.unfilled);
      if (tc.expected.am.shortfall) {
        expect(am.risk, "AM risk").toBe("shortfall");
      } else {
        expect(am.risk, "AM risk").not.toBe("shortfall");
      }

      expect(pm.required, "PM required").toBe(tc.expected.pm.required);
      expect(pm.unfilled, "PM unfilled").toBe(tc.expected.pm.unfilled);
      if (tc.expected.pm.shortfall) {
        expect(pm.risk, "PM risk").toBe("shortfall");
      } else {
        expect(pm.risk, "PM risk").not.toBe("shortfall");
      }
    });
  }
});
