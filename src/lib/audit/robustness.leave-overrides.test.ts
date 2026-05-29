import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Guards the invariant that an APPROVED leave request (annual, study,
 * compassionate, etc.) removes a staff member from EVERY availability
 * pool for both AM and PM on that day — and that the
 * theatre/POAC/pain-clinic exclusion (anyone on a `theatre_session` is
 * not redeployable) continues to hold for everyone else, including
 * when SPA assignments are mixed in.
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

const DATE = "2026-06-01"; // Monday

const CONS = (id: string) => ({
  id, full_name: id, grade: "consultant",
  training_level: null, ltft_days_off: [], active: true,
});
const SENIOR = (id: string) => ({
  id, full_name: id, grade: "trainee",
  training_level: "ST7", ltft_days_off: [], active: true,
});
const SAS_P = (id: string) => ({
  id, full_name: id, grade: "sas",
  training_level: null, ltft_days_off: [], active: true,
});

const ts = (id: string, session: "am" | "pm", theatreId = `theatre-${id}`) => ({
  id, session_date: DATE, session,
  theatre_id: theatreId, specialty_id: null,
});

const theatreAsn = (
  staff_id: string, session: "am" | "pm", theatre_session_id: string,
) => ({
  staff_id, session_date: DATE, session,
  duty_type: "theatre", theatre_session_id, role_on_list: "solo",
});

const spaAsn = (staff_id: string, session: "am" | "pm") => ({
  staff_id, session_date: DATE, session,
  duty_type: "spa", theatre_session_id: null, role_on_list: null,
});

const leave = (
  staff_id: string,
  type: "annual" | "study" | "compassionate" | "sick",
  opts: { start?: string; end?: string; status?: string } = {},
) => ({
  staff_id,
  type,
  start_date: opts.start ?? DATE,
  end_date: opts.end ?? DATE,
  status: opts.status ?? "approved",
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

describe("Leave overrides availability for both AM and PM", () => {
  for (const type of ["annual", "study", "compassionate"] as const) {
    it(`${type} leave removes consultant from AM and PM availability`, async () => {
      fixture.profiles = [CONS("c-off"), CONS("c-free")];
      fixture.leave_requests = [leave("c-off", type)];

      const am = await half("am");
      const pm = await half("pm");
      expect(am.consultantsAvailable).toBe(1);
      expect(pm.consultantsAvailable).toBe(1);
      expect(am.soloCapable).toBe(1);
      expect(pm.soloCapable).toBe(1);
    });
  }

  it("leave wins even if the person also has a theatre assignment that day", async () => {
    // Pathological data: booked AM theatre AND on annual leave.
    // Leave must remove them from every pool; they were never going to attend.
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t-am")];
    fixture.leave_requests = [leave("c1", "annual")];

    const am = await half("am");
    const pm = await half("pm");
    expect(am.consultantsAvailable).toBe(1); // only c2
    expect(am.consultantsOnSpa).toBe(0);
    expect(pm.consultantsAvailable).toBe(1);
  });

  it("leave wins over an SPA assignment (no flex cover from someone off)", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.rota_assignments = [spaAsn("c1", "am"), spaAsn("c1", "pm")];
    fixture.leave_requests = [leave("c1", "study")];

    const am = await half("am");
    const pm = await half("pm");
    expect(am.consultantsOnSpa).toBe(0);
    expect(am.consultantsAvailable).toBe(1);
    expect(pm.consultantsOnSpa).toBe(0);
    expect(pm.consultantsAvailable).toBe(1);
  });

  it("multi-day leave covers an in-range date", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.leave_requests = [
      leave("c1", "annual", { start: "2026-05-28", end: "2026-06-05" }),
    ];
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1);
  });

  it("PENDING leave does NOT remove the consultant from the pool", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.leave_requests = [leave("c1", "annual", { status: "pending" })];
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1);
  });

  it("trainee on annual leave is removed from senior pool AM and PM", async () => {
    fixture.profiles = [SENIOR("st7-a"), SENIOR("st7-b")];
    fixture.leave_requests = [leave("st7-a", "annual")];
    const am = await half("am");
    const pm = await half("pm");
    expect(am.seniorTraineesAvailable).toBe(1);
    expect(pm.seniorTraineesAvailable).toBe(1);
    expect(am.soloCapable).toBe(1);
    expect(pm.soloCapable).toBe(1);
  });

  it("SAS on study leave is removed from sasAvailable AM and PM", async () => {
    fixture.profiles = [SAS_P("s1"), SAS_P("s2")];
    fixture.leave_requests = [leave("s1", "study")];
    const am = await half("am");
    const pm = await half("pm");
    expect(am.sasAvailable).toBe(1);
    expect(pm.sasAvailable).toBe(1);
  });

  it("leave on one staff member does not affect others on theatre/POAC/pain-clinic exclusion", async () => {
    // c-off: on annual leave (excluded all day)
    // c-list: covering POAC AM list (excluded from AM pool)
    // c-pain: covering pain-clinic PM list (excluded from PM pool)
    // c-spa: SPA AM + free PM (flex AM, free PM)
    // c-free: free all day
    fixture.profiles = [
      CONS("c-off"), CONS("c-list"), CONS("c-pain"),
      CONS("c-spa"), CONS("c-free"),
    ];
    fixture.theatre_sessions = [
      ts("poac-am", "am", "room-poac"),
      ts("pain-pm", "pm", "room-pain"),
    ];
    fixture.rota_assignments = [
      theatreAsn("c-list", "am", "poac-am"),
      theatreAsn("c-pain", "pm", "pain-pm"),
      spaAsn("c-spa", "am"),
    ];
    fixture.leave_requests = [leave("c-off", "compassionate")];

    const am = await half("am");
    const pm = await half("pm");

    // AM: c-off (leave), c-list (on list), c-spa (spa) → free = c-pain, c-free
    expect(am.consultantsAvailable).toBe(2);
    expect(am.consultantsOnSpa).toBe(1);
    expect(am.soloCapable).toBe(2);
    // PM: c-off (leave), c-pain (on list) → free = c-list, c-spa, c-free
    expect(pm.consultantsAvailable).toBe(3);
    expect(pm.consultantsOnSpa).toBe(0);
  });

  it("everyone on leave plus the one remaining consultant on a theatre list → zero free pool", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2"), CONS("c3")];
    fixture.theatre_sessions = [ts("t-am", "am")];
    fixture.rota_assignments = [theatreAsn("c3", "am", "t-am")];
    fixture.leave_requests = [
      leave("c1", "annual"),
      leave("c2", "study"),
    ];
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(0);
    expect(am.consultantsOnSpa).toBe(0);
    expect(am.soloCapable).toBe(0);
    // 1 list, 1 filled → unfilled = 0; no headroom either.
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(0);
    expect(am.headroomWithSpa).toBe(0);
  });
});
