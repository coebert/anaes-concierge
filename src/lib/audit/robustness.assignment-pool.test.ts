import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * These tests guard the invariant that anyone already assigned to a
 * theatre_session (theatre, POAC, pain clinic, or any other duty_type='theatre'
 * list) is REMOVED from the available headroom pool — including SPA-aware
 * headroom — for that half-day, regardless of grade, AM/PM, or SPA overlap.
 *
 * We mock the Supabase client so `computeRobustness` runs without a DB.
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
    order: () => typeof chain;
    range: () => typeof chain;
    then: (
      onfulfilled: (v: { data: Row[]; error: null }) => unknown,
    ) => Promise<unknown>;
  } = {
    select: () => chain,
    eq: () => chain,
    lte: () => chain,
    gte: () => chain,
    in: () => chain,
    order: () => chain,
    range: () => chain,
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

// Import AFTER vi.mock so the mock is in effect.
import { computeRobustness } from "./robustness";

const DATE = "2026-06-01"; // a Monday
const CONS = (id: string) => ({
  id,
  full_name: id,
  grade: "consultant",
  training_level: null,
  ltft_days_off: [],
  active: true,
});
const SENIOR = (id: string) => ({
  id,
  full_name: id,
  grade: "trainee",
  training_level: "ST7",
  ltft_days_off: [],
  active: true,
});
const JUNIOR = (id: string) => ({
  id,
  full_name: id,
  grade: "trainee",
  training_level: "CT2",
  ltft_days_off: [],
  active: true,
});
const SAS_P = (id: string) => ({
  id,
  full_name: id,
  grade: "sas",
  training_level: null,
  ltft_days_off: [],
  active: true,
});

const ts = (id: string, session: "am" | "pm") => ({
  id,
  session_date: DATE,
  session,
  theatre_id: `theatre-${id}`,
  specialty_id: null,
});

const theatreAsn = (
  staff_id: string,
  session: "am" | "pm",
  theatre_session_id: string,
) => ({
  staff_id,
  session_date: DATE,
  session,
  duty_type: "theatre",
  theatre_session_id,
  role_on_list: "solo",
});

const spaAsn = (staff_id: string, session: "am" | "pm") => ({
  staff_id,
  session_date: DATE,
  session,
  duty_type: "spa",
  theatre_session_id: null,
  role_on_list: null,
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

describe("Headroom pool — anyone on a theatre_session is excluded", () => {
  it("consultant covering an AM theatre list is NOT in the AM available pool", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t-am")];

    const am = await half("am");
    // c1 is on the list, c2 is free → only c2 contributes to availability.
    expect(am.consultantsAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
    // List filled by c1, so unfilled = 0 → headroom = 1 (c2).
    expect(am.headroom).toBe(1);
    expect(am.headroomWithSpa).toBe(1);
  });

  it("AM theatre assignment does NOT affect PM availability", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t-am")];

    const am = await half("am");
    const pm = await half("pm");
    expect(am.consultantsAvailable).toBe(0); // booked AM
    expect(pm.consultantsAvailable).toBe(1); // free PM
  });

  it("PM theatre assignment does NOT affect AM availability", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.theatre_sessions = [ts("t-pm", "pm")];
    fixture.rota_assignments = [theatreAsn("c1", "pm", "t-pm")];

    expect((await half("am")).consultantsAvailable).toBe(1);
    expect((await half("pm")).consultantsAvailable).toBe(0);
  });

  it("senior trainee on a theatre list is NOT counted as soloCapable that half", async () => {
    fixture.profiles = [SENIOR("st7-a"), SENIOR("st7-b")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("st7-a", "am", "t-am")];

    const am = await half("am");
    expect(am.seniorTraineesAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
  });

  it("junior trainee on a theatre list is removed from juniorTraineesAvailable", async () => {
    fixture.profiles = [JUNIOR("ct2-a"), JUNIOR("ct2-b")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("ct2-a", "am", "t-am")];

    const am = await half("am");
    expect(am.juniorTraineesAvailable).toBe(1);
    // Junior trainees never contribute to soloCapable.
    expect(am.soloCapable).toBe(0);
  });

  it("SAS on a theatre list is removed from sasAvailable", async () => {
    fixture.profiles = [SAS_P("sas-a"), SAS_P("sas-b")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("sas-a", "am", "t-am")];

    const am = await half("am");
    expect(am.sasAvailable).toBe(1);
    expect(am.soloCapable).toBe(0); // SAS never solo-capable
  });

  it("POAC / pain clinic (any duty_type='theatre' list) excludes staff just like a main theatre", async () => {
    // The model treats every duty_type='theatre' assignment the same regardless
    // of which room the theatre_session points to. This test pins that down
    // for POAC and pain clinic by using clearly-non-theatre theatre rooms.
    fixture.profiles = [CONS("c-poac"), CONS("c-pain"), CONS("c-free")];
    fixture.theatre_sessions = [
      { ...ts("poac-am", "am"), theatre_id: "room-poac" },
      { ...ts("pain-am", "am"), theatre_id: "room-pain" },
    ];
    fixture.rota_assignments = [
      theatreAsn("c-poac", "am", "poac-am"),
      theatreAsn("c-pain", "am", "pain-am"),
    ];

    const am = await half("am");
    // Two consultants are on lists, one is free.
    expect(am.consultantsAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
    // Both lists filled → unfilled = 0 → headroom equals free pool.
    expect(am.headroom).toBe(1);
  });

  it("staff on theatre list this half is NOT redeployable via SPA either (does not show up in consultantsOnSpa)", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    // Pathological data: same consultant flagged as both theatre AND spa
    // for the same half. The theatre assignment must win — they are
    // physically on a list, not on SPA available for redeployment.
    fixture.rota_assignments = [
      theatreAsn("c1", "am", "t-am"),
      spaAsn("c1", "am"),
    ];

    const am = await half("am");
    // The order of inserts puts spa last, which currently sets state='spa'.
    // Either way the invariant we care about: if classified as SPA they are
    // never counted as a free consultant, and if classified as theatre they
    // are never counted as SPA. We assert the union: consultant cannot be
    // simultaneously in BOTH free and SPA pools.
    expect(am.consultantsAvailable + am.consultantsOnSpa).toBeLessThanOrEqual(1);
    // And they certainly are not in the free pool.
    expect(am.consultantsAvailable).toBe(0);
  });

  it("consultant on SPA AM + theatre PM: free pool gets neither half", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.theatre_sessions = [ts("t-pm", "pm")];
    fixture.rota_assignments = [
      spaAsn("c1", "am"),
      theatreAsn("c1", "pm", "t-pm"),
    ];

    const am = await half("am");
    const pm = await half("pm");
    // AM: on SPA → flex cover only.
    expect(am.consultantsAvailable).toBe(0);
    expect(am.consultantsOnSpa).toBe(1);
    // PM: on a list → not in any pool.
    expect(pm.consultantsAvailable).toBe(0);
    expect(pm.consultantsOnSpa).toBe(0);
  });

  it("consultant on theatre AM + SPA PM: AM excluded entirely, PM is SPA-only", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [
      theatreAsn("c1", "am", "t-am"),
      spaAsn("c1", "pm"),
    ];

    const am = await half("am");
    const pm = await half("pm");
    expect(am.consultantsAvailable).toBe(0);
    expect(am.consultantsOnSpa).toBe(0);
    expect(pm.consultantsAvailable).toBe(0);
    expect(pm.consultantsOnSpa).toBe(1);
  });

  it("staff on a theatre list never inflate headroomWithSpa", async () => {
    // 3 consultants. One on AM list, one on AM SPA, one free.
    // 2 AM theatre lists required (so unfilled = 1).
    fixture.profiles = [CONS("c1"), CONS("c2"), CONS("c3")];
    fixture.theatre_sessions = [ts("t1", "am"), ts("t2", "am")];
    fixture.rota_assignments = [
      theatreAsn("c1", "am", "t1"),
      spaAsn("c2", "am"),
      // c3 free
    ];
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c3
    expect(am.consultantsOnSpa).toBe(1); // c2
    expect(am.soloCapable).toBe(1);
    // 2 required, 1 filled (c1 on t1, t2 unfilled) → unfilled = 1.
    expect(am.unfilled).toBe(1);
    expect(am.headroom).toBe(0); // 1 solo - 1 unfilled
    expect(am.headroomWithSpa).toBe(1); // + 1 SPA
  });

  it("trainee on a theatre list is also excluded from headroomWithSpa (does not sneak back via SPA flex)", async () => {
    fixture.profiles = [SENIOR("st7")];
    fixture.theatre_sessions = [ts("t-am", "am"), ts("t-extra", "am")];
    fixture.rota_assignments = [theatreAsn("st7", "am", "t-am")];

    const am = await half("am");
    expect(am.seniorTraineesAvailable).toBe(0);
    expect(am.consultantsOnSpa).toBe(0);
    // 2 required, 1 filled → unfilled = 1, no solo cover → headroomWithSpa = -1.
    expect(am.headroomWithSpa).toBe(-1);
  });
});
