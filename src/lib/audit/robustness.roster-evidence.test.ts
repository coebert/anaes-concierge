import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

interface Fixture {
  profiles: Row[];
  leave_requests: Row[];
  theatre_sessions: Row[];
  rota_assignments: Row[];
  duty_type_pool_rules: Row[];
  specialties: Row[];
}

let fixture: Fixture = {
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
};

function chain(table: string) {
  const c: Record<string, unknown> = {};
  ["select", "eq", "lte", "gte", "in", "order", "range"].forEach(
    (m) => (c[m] = () => c),
  );
  c.then = (ok: (v: { data: Row[]; error: null }) => unknown) =>
    Promise.resolve({
      data: (fixture as unknown as Record<string, Row[]>)[table] ?? [],
      error: null,
    }).then(ok);
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
});

describe("computeRobustness — requireRosterEvidence (default true)", () => {
  it("does NOT count consultants who have no assignment that day", async () => {
    fixture.profiles = [
      { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
      { id: "c2", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
      { id: "c3", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    ];
    // Only c1 has an assignment (an AM theatre list) — c2 and c3 are not rostered.
    fixture.theatre_sessions = [
      { id: "ts1", session_date: DATE, session: "am", specialty_id: null, surgical_consultant: null },
    ];
    fixture.rota_assignments = [
      { staff_id: "c1", session_date: DATE, session: "am", duty_type: "theatre", theatre_session_id: "ts1" },
    ];

    const { days } = await computeRobustness(DATE, DATE);
    const am = days[0].am;
    // c1 is covering the list, c2/c3 are not rostered → 0 free consultants.
    expect(am.consultantsAvailable).toBe(0);
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(0);
  });

  it("counts a consultant who is rostered (SPA in AM) as available in PM", async () => {
    fixture.profiles = [
      { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    ];
    fixture.rota_assignments = [
      // Rostered in AM on SPA, nothing in PM — they are at work today.
      { staff_id: "c1", session_date: DATE, session: "am", duty_type: "spa", theatre_session_id: null },
    ];
    const { days } = await computeRobustness(DATE, DATE);
    expect(days[0].am.consultantsOnSpa).toBe(1);
    expect(days[0].am.consultantsAvailable).toBe(0);
    // PM: rostered today, no clinical commitment → counted as free.
    expect(days[0].pm.consultantsAvailable).toBe(1);
  });

  it("legacy mode (requireRosterEvidence=false) counts unrostered staff as available", async () => {
    fixture.profiles = [
      { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
      { id: "c2", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    ];
    fixture.rota_assignments = [];
    const { days } = await computeRobustness(DATE, DATE, [], {
      requireRosterEvidence: false,
    });
    expect(days[0].am.consultantsAvailable).toBe(2);
  });
});
