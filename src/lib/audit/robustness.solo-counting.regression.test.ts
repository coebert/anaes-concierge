import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression tests for the solo-trainee counting change.
 *
 * The UI dashboard now (a) excludes trainees with no `theatre_session_id`
 * (unassigned-theatre) from the "solo trainees today" widget and (b) only
 * counts trainees on a specific list with no consultant assigned to the
 * same list. These tests guarantee the downstream robustness and per-day
 * coverage calculations are unaffected by that UI-side change: lists,
 * unfilled counts, soloCapable, headroom, spa_required, and the
 * per-day list-coverage breakdown all keep their pre-change semantics.
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

import { computeRobustness, computeListCoverage } from "./robustness";

const DATE = "2026-06-01"; // Monday

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

const ts = (id: string, session: "am" | "pm", date = DATE) => ({
  id, session_date: date, session,
  theatre_id: `theatre-${id}`, specialty_id: null,
});

const theatreAsn = (
  staff_id: string,
  session: "am" | "pm",
  theatre_session_id: string | null,
  role_on_list: "solo" | "supervised" | "supervisee" | "trainee" = "solo",
  date = DATE,
) => ({
  staff_id,
  session_date: date,
  session,
  duty_type: "theatre",
  theatre_session_id,
  role_on_list,
  // For the listCoverage query we need an `inner` profile join — the mock
  // chain just returns whatever rows the table holds, so embed it on the
  // row directly. computeRobustness doesn't read `profiles` off the row.
  profiles: profileOf(staff_id),
});

// Lookup helper so theatreAsn() can embed the joined profile object the
// computeListCoverage selector expects.
function profileOf(id: string): { grade: string | null; training_level: string | null } {
  const p = fixture.profiles.find((p) => (p as { id: string }).id === id) as
    | { grade: string | null; training_level: string | null }
    | undefined;
  return p
    ? { grade: p.grade, training_level: p.training_level }
    : { grade: null, training_level: null };
}

beforeEach(() => {
  fixture = {
    profiles: [],
    leave_requests: [],
    theatre_sessions: [],
    rota_assignments: [],
    duty_type_pool_rules: DEFAULT_POOL_RULES,
  };
});

describe("Regression — solo counting change does not break robustness", () => {
  it("trainee assigned to a specific list with no consultant: list is filled, headroom unchanged", async () => {
    // 2 AM lists. ST7 trainee covers t1 solo; t2 unfilled.
    fixture.profiles = [CONS("c1"), CONS("c2"), SENIOR("st7-a")];
    fixture.theatre_sessions = [ts("t1", "am"), ts("t2", "am")];
    fixture.rota_assignments = [theatreAsn("st7-a", "am", "t1", "solo")];

    const { days } = await computeRobustness(DATE, DATE, [], { requireRosterEvidence: false });
    const am = days[0].am;
    expect(am.required).toBe(2);
    expect(am.unfilled).toBe(1); // t2 still unfilled
    // Both consultants free + 0 free senior trainees (st7-a is on t1)
    expect(am.consultantsAvailable).toBe(2);
    expect(am.seniorTraineesAvailable).toBe(0);
    expect(am.soloCapable).toBe(2);
    expect(am.headroom).toBe(1); // 2 - 1
    expect(am.risk).toBe("tight"); // headroom <= 1
  });

  it("unassigned-theatre trainee row does NOT change unfilled / soloCapable / headroom", async () => {
    // One list (t1) with a consultant on it. A trainee with no
    // theatre_session_id (the buggy 'solo' row) must not change unfilled
    // counts, soloCapable, or headroom — the only effect is that the
    // trainee is treated as busy on a clinical list this half.
    fixture.profiles = [CONS("c1"), CONS("c2"), JUNIOR("ct2-a")];
    fixture.theatre_sessions = [ts("t1", "am")];
    fixture.rota_assignments = [
      theatreAsn("c1", "am", "t1", "solo"),
      theatreAsn("ct2-a", "am", null, "solo"), // unassigned theatre
    ];

    const { days } = await computeRobustness(DATE, DATE, [], { requireRosterEvidence: false });
    const am = days[0].am;
    expect(am.required).toBe(1);
    expect(am.unfilled).toBe(0); // unassigned row must not bump unfilled
    expect(am.consultantsAvailable).toBe(1); // c2 free
    expect(am.soloCapable).toBe(1);
    expect(am.headroom).toBe(1);
  });

  it("trainee + consultant on the same list: list is solo-capable, both excluded from pool", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2"), JUNIOR("ct2-a"), SENIOR("st7-a")];
    fixture.theatre_sessions = [ts("t1", "am")];
    fixture.rota_assignments = [
      theatreAsn("c1", "am", "t1", "supervised"),
      theatreAsn("ct2-a", "am", "t1", "supervisee"),
    ];

    const { days } = await computeRobustness(DATE, DATE, [], { requireRosterEvidence: false });
    const am = days[0].am;
    expect(am.unfilled).toBe(0);
    expect(am.consultantsAvailable).toBe(1); // only c2
    expect(am.juniorTraineesAvailable).toBe(0); // ct2-a on the list
    expect(am.seniorTraineesAvailable).toBe(1); // st7-a still free
    expect(am.soloCapable).toBe(2);
  });

  it("shortfall path stays correct: 2 unfilled lists, 1 consultant, no senior trainees → shortfall", async () => {
    fixture.profiles = [CONS("c1"), JUNIOR("ct2-a")];
    fixture.theatre_sessions = [ts("t1", "am"), ts("t2", "am")];
    fixture.rota_assignments = [];

    const am = (await computeRobustness(DATE, DATE, [], { requireRosterEvidence: false })).days[0].am;
    expect(am.unfilled).toBe(2);
    expect(am.soloCapable).toBe(1);
    expect(am.headroom).toBe(-1);
    expect(am.risk).toBe("shortfall");
  });

  it("spa_required path stays correct: shortfall closes only with a consultant on SPA", async () => {
    // 2 lists, 1 free consultant, 1 consultant on SPA → spa_required
    fixture.profiles = [CONS("c1"), CONS("c-spa")];
    fixture.theatre_sessions = [ts("t1", "am"), ts("t2", "am")];
    fixture.rota_assignments = [
      { staff_id: "c-spa", session_date: DATE, session: "am",
        duty_type: "spa", theatre_session_id: null, role_on_list: "solo" },
    ];

    const am = (await computeRobustness(DATE, DATE, [], { requireRosterEvidence: false })).days[0].am;
    expect(am.unfilled).toBe(2);
    expect(am.soloCapable).toBe(1);
    expect(am.consultantsOnSpa).toBe(1);
    expect(am.headroom).toBe(-1);
    expect(am.headroomWithSpa).toBe(0);
    expect(am.risk).toBe("spa_required");
  });

  it("AM and PM are independent: PM trainee on a solo list does not affect AM headroom", async () => {
    fixture.profiles = [CONS("c1"), SENIOR("st7-a")];
    fixture.theatre_sessions = [ts("t-am", "am"), ts("t-pm", "pm")];
    fixture.rota_assignments = [
      theatreAsn("st7-a", "pm", "t-pm", "solo"),
    ];

    const { days } = await computeRobustness(DATE, DATE, [], { requireRosterEvidence: false });
    const am = days[0].am;
    const pm = days[0].pm;
    expect(am.unfilled).toBe(1);
    expect(am.seniorTraineesAvailable).toBe(1); // st7-a free in AM
    expect(pm.unfilled).toBe(0);
    expect(pm.seniorTraineesAvailable).toBe(0); // st7-a busy in PM
  });
});

describe("Regression — solo counting change does not break per-day list coverage", () => {
  it("trainee-only list (no consultant) is reported as supervised, not solo-capable", async () => {
    // Junior trainee covers t1 alone → list is filled-but-supervised, NOT solo-capable.
    fixture.profiles = [JUNIOR("ct2-a")];
    fixture.theatre_sessions = [ts("t1", "am")];
    fixture.rota_assignments = [theatreAsn("ct2-a", "am", "t1", "solo")];

    const cov = await computeListCoverage(DATE, DATE);
    expect(cov).toHaveLength(1);
    expect(cov[0].am).toEqual({
      total: 1,
      soloCapable: 0,
      supervised: 1,
      unfilled: 0,
      spaNeeded: false,
    });
  });

  it("senior trainee alone on a list IS solo-capable", async () => {
    fixture.profiles = [SENIOR("st7-a")];
    fixture.theatre_sessions = [ts("t1", "am")];
    fixture.rota_assignments = [theatreAsn("st7-a", "am", "t1", "solo")];

    const am = (await computeListCoverage(DATE, DATE))[0].am;
    expect(am.soloCapable).toBe(1);
    expect(am.supervised).toBe(0);
    expect(am.unfilled).toBe(0);
  });

  it("consultant + trainee on the same list: solo-capable counted once", async () => {
    fixture.profiles = [CONS("c1"), JUNIOR("ct2-a")];
    fixture.theatre_sessions = [ts("t1", "am")];
    fixture.rota_assignments = [
      theatreAsn("c1", "am", "t1", "supervised"),
      theatreAsn("ct2-a", "am", "t1", "supervisee"),
    ];

    const am = (await computeListCoverage(DATE, DATE))[0].am;
    expect(am.total).toBe(1);
    expect(am.soloCapable).toBe(1);
    expect(am.supervised).toBe(0);
    expect(am.unfilled).toBe(0);
  });

  it("unfilled list (no assignments) counted as unfilled, not supervised or solo-capable", async () => {
    fixture.profiles = [CONS("c1")];
    fixture.theatre_sessions = [ts("t1", "am"), ts("t2", "am")];
    fixture.rota_assignments = [theatreAsn("c1", "am", "t1", "solo")];

    const am = (await computeListCoverage(DATE, DATE))[0].am;
    expect(am.total).toBe(2);
    expect(am.soloCapable).toBe(1);
    expect(am.supervised).toBe(0);
    expect(am.unfilled).toBe(1);
  });

  it("AM/PM totals reported independently", async () => {
    fixture.profiles = [CONS("c1"), SENIOR("st7-a"), JUNIOR("ct2-a")];
    fixture.theatre_sessions = [
      ts("t-am-1", "am"), ts("t-am-2", "am"),
      ts("t-pm-1", "pm"),
    ];
    fixture.rota_assignments = [
      theatreAsn("c1", "am", "t-am-1", "solo"),     // solo-capable AM
      theatreAsn("ct2-a", "am", "t-am-2", "solo"),  // supervised AM (junior only)
      theatreAsn("st7-a", "pm", "t-pm-1", "solo"),  // solo-capable PM
    ];

    const day = (await computeListCoverage(DATE, DATE))[0];
    expect(day.am).toMatchObject({ total: 2, soloCapable: 1, supervised: 1, unfilled: 0 });
    expect(day.pm).toMatchObject({ total: 1, soloCapable: 1, supervised: 0, unfilled: 0 });
  });

  it("7-day strip: counts only weekdays and preserves spaNeeded flag", async () => {
    // Build a tiny 7-day fixture: only Mon has a list, others empty.
    fixture.profiles = [CONS("c1"), CONS("c-spa")];
    fixture.theatre_sessions = [
      ts("t1", "am", "2026-06-01"),
      ts("t2", "am", "2026-06-01"),
    ];
    fixture.rota_assignments = [
      { staff_id: "c-spa", session_date: "2026-06-01", session: "am",
        duty_type: "spa", theatre_session_id: null, role_on_list: "solo",
        profiles: profileOf("c-spa") },
    ];

    const cov = await computeListCoverage("2026-06-01", "2026-06-07");
    // 2026-06-01 Mon … 2026-06-05 Fri → 5 weekdays.
    expect(cov.map((d) => d.date)).toEqual([
      "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
    ]);
    expect(cov[0].am.total).toBe(2);
    expect(cov[0].am.unfilled).toBe(2);
    // 2 unfilled, 1 free consultant, 1 on SPA → spa_required propagates.
    expect(cov[0].am.spaNeeded).toBe(true);
    // Other days have no lists → all zero, spaNeeded false.
    for (const d of cov.slice(1)) {
      expect(d.am.total).toBe(0);
      expect(d.pm.total).toBe(0);
      expect(d.am.spaNeeded).toBe(false);
      expect(d.pm.spaNeeded).toBe(false);
    }
  });
});
