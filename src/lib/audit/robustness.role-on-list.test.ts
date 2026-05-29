import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Guards the invariant that ANY theatre-list assignment — whether the
 * role_on_list is "solo", "supervised", "supervisee" or "trainee" — pulls
 * that staff member out of the half-day headroom pool that matches their
 * grade. A consultant supervising a trainee is still unavailable for
 * redeployment; a trainee being supervised is still unavailable; and the
 * underlying theatre_session counts as filled exactly once even when two
 * people (supervisor + supervisee) are assigned to it.
 */

type Row = Record<string, unknown>;

interface Fixture {
  profiles: Row[];
  leave_requests: Row[];
  theatre_sessions: Row[];
  rota_assignments: Row[];
  duty_type_pool_rules: Row[];
}

const DEFAULT_POOL_RULES: Row[] = [
  { duty_type: "theatre", category: "clinical_list" },
  { duty_type: "spa", category: "flex" },
  { duty_type: "icu_consultant_oncall", category: "excluded" },
  { duty_type: "general_consultant_oncall", category: "excluded" },
  { duty_type: "registrar_oncall", category: "excluded" },
  { duty_type: "sho_oncall", category: "excluded" },
  { duty_type: "icu_trainee", category: "excluded" },
  { duty_type: "icu_ct2_plus", category: "excluded" },
  { duty_type: "obstetrics", category: "excluded" },
  { duty_type: "obstetrics_2nd", category: "excluded" },
  { duty_type: "consultant_in_charge", category: "excluded" },
  { duty_type: "teaching", category: "excluded" },
  { duty_type: "non_clinical", category: "excluded" },
  { duty_type: "admin", category: "excluded" },
];

let fixture: Fixture = {
  profiles: [],
  leave_requests: [],
  theatre_sessions: [],
  rota_assignments: [],
  duty_type_pool_rules: DEFAULT_POOL_RULES,
};

function makeChain(table: string) {
  const chain: {
    select: () => typeof chain;
    eq: () => typeof chain;
    lte: () => typeof chain;
    gte: () => typeof chain;
    in: () => typeof chain;
    then: (
      onfulfilled: (v: { data: Row[]; error: null }) => unknown,
    ) => Promise<unknown>;
  } = {
    select: () => chain,
    eq: () => chain,
    lte: () => chain,
    gte: () => chain,
    in: () => chain,
    then: (onfulfilled) =>
      Promise.resolve({
        data: (fixture as unknown as Record<string, Row[]>)[table] ?? [],
        error: null,
      }).then(onfulfilled),
  };
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeChain(table as keyof Fixture),
  },
}));

import { computeRobustness } from "./robustness";

const DATE = "2026-06-01";

const CONS = (id: string) => ({
  id, full_name: id, grade: "consultant",
  training_level: null, ltft_days_off: [], active: true,
});
const SENIOR = (id: string) => ({
  id, full_name: id, grade: "trainee",
  training_level: "ST7", ltft_days_off: [], active: true,
});
const JUNIOR = (id: string) => ({
  id, full_name: id, grade: "trainee",
  training_level: "CT2", ltft_days_off: [], active: true,
});

const ts = (id: string, session: "am" | "pm") => ({
  id, session_date: DATE, session,
  theatre_id: `theatre-${id}`, specialty_id: null,
});

const theatreAsn = (
  staff_id: string,
  session: "am" | "pm",
  theatre_session_id: string,
  role_on_list: "solo" | "supervised" | "supervisee" | "trainee",
  supervisor_id: string | null = null,
) => ({
  staff_id,
  session_date: DATE,
  session,
  duty_type: "theatre",
  theatre_session_id,
  role_on_list,
  supervisor_id,
});

beforeEach(() => {
  fixture = {
    profiles: [],
    leave_requests: [],
    theatre_sessions: [],
    rota_assignments: [],
    duty_type_pool_rules: DEFAULT_POOL_RULES,
  };
});

async function half(side: "am" | "pm") {
  const { days } = await computeRobustness(DATE, DATE);
  expect(days).toHaveLength(1);
  return days[0][side];
}

describe("Headroom pool exclusion by role_on_list", () => {
  it("consultant in SOLO role is excluded from consultantsAvailable", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t-am", "solo")];

    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c2
    expect(am.soloCapable).toBe(1);
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(1);
  });

  it("consultant in SUPERVISED role (supervising a trainee) is also excluded", async () => {
    // A consultant assigned to a list to supervise a trainee is physically
    // on that list and not redeployable. role_on_list != "solo" must not
    // sneak them back into the free pool.
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t-am", "supervised")];

    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
  });

  it("senior trainee in SOLO role is excluded from seniorTraineesAvailable", async () => {
    fixture.profiles = [SENIOR("st7-a"), SENIOR("st7-b")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("st7-a", "am", "t-am", "solo")];

    const am = await half("am");
    expect(am.seniorTraineesAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
  });

  it("senior trainee in SUPERVISED role is still excluded from seniorTraineesAvailable", async () => {
    fixture.profiles = [SENIOR("st7-a"), SENIOR("st7-b")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("st7-a", "am", "t-am", "supervised")];

    const am = await half("am");
    expect(am.seniorTraineesAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
  });

  it("junior trainee in SUPERVISED role is excluded from juniorTraineesAvailable", async () => {
    fixture.profiles = [JUNIOR("ct2-a"), JUNIOR("ct2-b")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("ct2-a", "am", "t-am", "supervised")];

    const am = await half("am");
    expect(am.juniorTraineesAvailable).toBe(1);
    // Juniors never solo-capable, regardless of role.
    expect(am.soloCapable).toBe(0);
  });

  it("supervisor + supervisee on the SAME list: both excluded, list counts as 1 filled", async () => {
    // c-sup supervises st7-train on the same theatre_session.
    // Both come off the pool; the underlying list is filled once.
    fixture.profiles = [
      CONS("c-sup"), CONS("c-free"),
      SENIOR("st7-train"), SENIOR("st7-free"),
    ];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [
      theatreAsn("c-sup", "am", "t-am", "supervised", null),
      theatreAsn("st7-train", "am", "t-am", "supervisee", "c-sup"),
    ];

    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c-free
    expect(am.seniorTraineesAvailable).toBe(1); // only st7-free
    expect(am.soloCapable).toBe(2);
    // The list was filled exactly once → unfilled = 0
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(2);
  });

  it("supervised consultant only affects the half-day they cover (AM ≠ PM)", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t-am", "supervised")];

    expect((await half("am")).consultantsAvailable).toBe(0);
    expect((await half("pm")).consultantsAvailable).toBe(1);
  });

  it("role_on_list does not change headroom maths: solo vs supervised yield identical pools", async () => {
    // Setup A: c1 on theatre list as solo
    fixture.profiles = [CONS("c1"), CONS("c2"), CONS("c3")];
    fixture.theatre_sessions = [ts("t1", "am"), ts("t2", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t1", "solo")];
    const soloAm = await half("am");

    // Setup B: same shape but role is supervised
    fixture.rota_assignments = [theatreAsn("c1", "am", "t1", "supervised")];
    const supAm = await half("am");

    expect(soloAm.consultantsAvailable).toBe(supAm.consultantsAvailable);
    expect(soloAm.soloCapable).toBe(supAm.soloCapable);
    expect(soloAm.unfilled).toBe(supAm.unfilled);
    expect(soloAm.headroom).toBe(supAm.headroom);
    expect(soloAm.headroomWithSpa).toBe(supAm.headroomWithSpa);
  });

  it("trainee in 'trainee' role (legacy alias) is excluded from the trainee pool", async () => {
    fixture.profiles = [SENIOR("st7-a"), SENIOR("st7-b")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("st7-a", "am", "t-am", "trainee")];

    const am = await half("am");
    expect(am.seniorTraineesAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
  });
});
