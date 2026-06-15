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

// Minimal chainable mock that honours `.eq("active", false)` for the
// theatres lookup so the audit's "inactive theatre" filter sees only the
// rows we mark inactive in the fixture.
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

describe("computeRobustness — inactive theatre regression", () => {
  it("does not flag a shortfall when every active theatre is staffed and only a legacy (inactive) theatre is unstaffed", async () => {
    // Two consultants, each covering one active theatre AM list.
    fixture.profiles = [
      { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
      { id: "c2", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    ];
    fixture.theatres = [
      { id: "t-active-1", active: true },
      { id: "t-active-2", active: true },
      // "NHH (legacy)" — disabled in admin but a stale theatre_sessions row
      // remains attached to it.
      { id: "t-legacy", active: false },
    ];
    fixture.theatre_sessions = [
      { id: "ts1", session_date: DATE, session: "am", specialty_id: null, surgical_consultant: null, theatre_id: "t-active-1" },
      { id: "ts2", session_date: DATE, session: "am", specialty_id: null, surgical_consultant: null, theatre_id: "t-active-2" },
      // Phantom list on the inactive theatre — must not be counted as demand.
      { id: "ts-legacy", session_date: DATE, session: "am", specialty_id: null, surgical_consultant: null, theatre_id: "t-legacy" },
    ];
    fixture.rota_assignments = [
      { staff_id: "c1", session_date: DATE, session: "am", duty_type: "theatre", theatre_session_id: "ts1" },
      { staff_id: "c2", session_date: DATE, session: "am", duty_type: "theatre", theatre_session_id: "ts2" },
    ];

    const { days } = await computeRobustness(DATE, DATE);
    const am = days[0].am;

    // Only the 2 active-theatre lists count as demand. Both are filled.
    expect(am.required).toBe(2);
    expect(am.unfilled).toBe(0);
    // No consultant shortfall: headroom (no spare staff, no unfilled lists) is 0,
    // not negative, and risk is not "shortfall".
    expect(am.headroom).toBeGreaterThanOrEqual(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("DOES flag a shortfall when an ACTIVE theatre list is genuinely unfilled (control)", async () => {
    fixture.profiles = [
      { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    ];
    fixture.theatres = [
      { id: "t-active-1", active: true },
      { id: "t-active-2", active: true },
    ];
    fixture.theatre_sessions = [
      { id: "ts1", session_date: DATE, session: "am", specialty_id: null, surgical_consultant: null, theatre_id: "t-active-1" },
      { id: "ts2", session_date: DATE, session: "am", specialty_id: null, surgical_consultant: null, theatre_id: "t-active-2" },
    ];
    // Only one of the two active lists is covered.
    fixture.rota_assignments = [
      { staff_id: "c1", session_date: DATE, session: "am", duty_type: "theatre", theatre_session_id: "ts1" },
    ];

    const { days } = await computeRobustness(DATE, DATE);
    const am = days[0].am;
    expect(am.required).toBe(2);
    expect(am.unfilled).toBe(1);
    expect(am.risk).toBe("shortfall");
  });
});
