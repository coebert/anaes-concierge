import { describe, expect, it, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

interface Fixture {
  profiles: Row[];
  theatres: Row[];
  specialties: Row[];
  theatre_sessions: Row[];
  rota_assignments: Row[];
}

let fixture: Fixture = {
  profiles: [],
  theatres: [],
  specialties: [],
  theatre_sessions: [],
  rota_assignments: [],
};

function makeChain(table: keyof Fixture) {
  const chain: {
    select: () => typeof chain;
    gte: () => typeof chain;
    lte: () => typeof chain;
    order: () => typeof chain;
    range: () => typeof chain;
    then: (
      onfulfilled: (v: { data: Row[]; error: null }) => unknown,
    ) => Promise<unknown>;
  } = {
    select: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    range: () => chain,
    then: (onfulfilled) =>
      Promise.resolve({ data: fixture[table] ?? [], error: null }).then(onfulfilled),
  };
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: keyof Fixture) => makeChain(table) },
}));

import { computeListFeasibility } from "./list-feasibility";

const coeId = "2485548e-ccf1-4380-bac5-73e846aeb0e8";

beforeEach(() => {
  fixture = {
    profiles: [
      {
        id: coeId,
        full_name: "Dr R Coe",
        grade: "consultant",
        active: true,
        ltft_days_off: [],
      },
    ],
    theatres: [{ id: "t1", name: "Theatre 1" }],
    specialties: [],
    theatre_sessions: [],
    rota_assignments: [],
  };
});

describe("list feasibility working patterns — CLWRota off-day labels", () => {
  it("does not count 'Surgeon: Off Day' rows as Friday clinical availability", async () => {
    const dates = [
      "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
      "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12",
      "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19",
      "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26",
      "2026-06-29", "2026-06-30",
    ];

    for (const date of dates) {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      for (const session of ["am", "pm"] as const) {
        fixture.theatre_sessions.push({
          id: `ts-${date}-${session}`,
          session_date: date,
          session,
          theatre_id: "t1",
          surgical_consultant: dow === 5 ? "Off Day" : "Regular Surgeon",
          specialty_id: null,
        });

        fixture.rota_assignments.push({
          staff_id: coeId,
          session_date: date,
          session,
          duty_type: "theatre",
          role_on_list: "solo",
          theatre_session_id: dow === 5 ? null : `ts-${date}-${session}`,
          notes: dow === 5 ? "Surgeon: Off Day" : "Surgeon: Regular Surgeon",
        });
      }
    }

    const result = await computeListFeasibility({
      monthsBack: 1,
      todayOverride: "2026-06-30",
    });
    const coe = result.consultantPatterns.find((p) => p.id === coeId);
    expect(coe).toBeTruthy();

    const fridayCells = coe!.cells.filter((c) => c.dow === 5);
    expect(fridayCells).toHaveLength(2);
    expect(fridayCells.every((c) => c.regularDayOff)).toBe(true);
    expect(fridayCells.every((c) => c.workingPct === 0)).toBe(true);
    expect(fridayCells.every((c) => c.workingOccurrences === 0)).toBe(true);
  });
});