import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration-style tests across a multi-day rota window. The headroom
 * invariants must hold day-by-day even when leave, theatre lists, SPA, and
 * carry-over patterns (multi-day leave, recurring lists, on-call carry-over
 * via excluded duty_type) shift between weekdays.
 *
 * The mock Supabase client returns the same fixture for every query; the
 * underlying robustness pipeline does the date slicing.
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

// Monday → Friday window (weekdays only).
const MON = "2026-06-01";
const TUE = "2026-06-02";
const WED = "2026-06-03";
const THU = "2026-06-04";
const FRI = "2026-06-05";

const CONS = (id: string) => ({
  id, full_name: id, grade: "consultant",
  training_level: null, ltft_days_off: [], active: true,
});
const SENIOR = (id: string) => ({
  id, full_name: id, grade: "trainee",
  training_level: "ST7", ltft_days_off: [], active: true,
});

const ts = (date: string, session: "am" | "pm", suffix = "") => ({
  id: `ts-${date}-${session}${suffix}`,
  session_date: date, session,
  theatre_id: `room-${session}${suffix}`,
  specialty_id: null,
});

const theatreAsn = (
  staff_id: string, date: string, session: "am" | "pm",
  theatre_session_id: string,
  role_on_list: "solo" | "supervised" = "solo",
) => ({
  staff_id, session_date: date, session,
  duty_type: "theatre", theatre_session_id, role_on_list,
});

const spaAsn = (staff_id: string, date: string, session: "am" | "pm") => ({
  staff_id, session_date: date, session,
  duty_type: "spa", theatre_session_id: null, role_on_list: null,
});

const onCallAsn = (
  staff_id: string, date: string,
  duty_type: "icu_consultant_oncall" | "general_consultant_oncall",
) => ({
  staff_id, session_date: date, session: "am",
  duty_type, theatre_session_id: null, role_on_list: null,
});

const leave = (
  staff_id: string, start: string, end: string,
  type: "annual" | "study" | "compassionate" = "annual",
) => ({
  staff_id, type, start_date: start, end_date: end, status: "approved",
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

async function run() {
  const { days } = await computeRobustness(MON, FRI);
  // Index by date for ergonomic assertions.
  const byDate = new Map(days.map((d) => [d.date, d]));
  return { days, byDate };
}

/** Invariants that must hold on every half-day of every result. */
function assertInvariants(days: Awaited<ReturnType<typeof run>>["days"]) {
  for (const d of days) {
    for (const side of ["am", "pm"] as const) {
      const h = d[side];
      // Solo = consultants + senior trainees (definitional).
      expect(h.soloCapable).toBe(
        h.consultantsAvailable + h.seniorTraineesAvailable,
      );
      // headroom = solo - unfilled.
      expect(h.headroom).toBe(h.soloCapable - h.unfilled);
      // headroomWithSpa = solo + consultantsOnSpa - unfilled.
      expect(h.headroomWithSpa).toBe(
        h.soloCapable + h.consultantsOnSpa - h.unfilled,
      );
      // No pool count can be negative.
      expect(h.consultantsAvailable).toBeGreaterThanOrEqual(0);
      expect(h.seniorTraineesAvailable).toBeGreaterThanOrEqual(0);
      expect(h.juniorTraineesAvailable).toBeGreaterThanOrEqual(0);
      expect(h.sasAvailable).toBeGreaterThanOrEqual(0);
      expect(h.consultantsOnSpa).toBeGreaterThanOrEqual(0);
      // Required and unfilled bounded by physical theatre count.
      expect(h.unfilled).toBeLessThanOrEqual(h.required);
    }
  }
}

describe("Multi-day rota — headroom invariants across consecutive weekdays", () => {
  it("returns one entry per weekday (Mon–Fri = 5 days, skipping weekends)", async () => {
    fixture.profiles = [CONS("c1")];
    const { days } = await run();
    expect(days.map((d) => d.date)).toEqual([MON, TUE, WED, THU, FRI]);
  });

  it("identical rota each day → identical headroom across the week", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2"), CONS("c3"), SENIOR("st7")];
    fixture.theatre_sessions = [
      ts(MON, "am"), ts(TUE, "am"), ts(WED, "am"),
      ts(THU, "am"), ts(FRI, "am"),
    ];
    fixture.rota_assignments = [
      theatreAsn("c1", MON, "am", "ts-2026-06-01-am"),
      theatreAsn("c1", TUE, "am", "ts-2026-06-02-am"),
      theatreAsn("c1", WED, "am", "ts-2026-06-03-am"),
      theatreAsn("c1", THU, "am", "ts-2026-06-04-am"),
      theatreAsn("c1", FRI, "am", "ts-2026-06-05-am"),
    ];

    const { days } = await run();
    assertInvariants(days);
    const am = days.map((d) => d.am.headroom);
    expect(new Set(am).size).toBe(1);
    // 1 list filled per day, c2+c3+st7 free → soloCapable=3, unfilled=0.
    expect(am[0]).toBe(3);
  });

  it("multi-day annual leave carries over Mon→Wed but releases Thu+Fri", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.leave_requests = [leave("c1", MON, WED)];

    const { byDate } = await run();
    assertInvariants(Array.from(byDate.values()));
    expect(byDate.get(MON)!.am.consultantsAvailable).toBe(1);
    expect(byDate.get(TUE)!.am.consultantsAvailable).toBe(1);
    expect(byDate.get(WED)!.am.consultantsAvailable).toBe(1);
    expect(byDate.get(THU)!.am.consultantsAvailable).toBe(2);
    expect(byDate.get(FRI)!.am.consultantsAvailable).toBe(2);
  });

  it("leave that starts before the window still applies to in-range days", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    // Leave spans previous week into our Monday.
    fixture.leave_requests = [leave("c1", "2026-05-25", MON)];

    const { byDate } = await run();
    expect(byDate.get(MON)!.am.consultantsAvailable).toBe(1);
    expect(byDate.get(TUE)!.am.consultantsAvailable).toBe(2);
  });

  it("rolling theatre coverage: a consultant on a different list each day cannot redeploy that day", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2"), SENIOR("st7")];
    fixture.theatre_sessions = [
      ts(MON, "am"), ts(TUE, "am"), ts(WED, "am"),
      ts(THU, "am"), ts(FRI, "am"),
    ];
    // c1 covers a list every day, rotating through.
    fixture.rota_assignments = [
      theatreAsn("c1", MON, "am", "ts-2026-06-01-am"),
      theatreAsn("c1", TUE, "am", "ts-2026-06-02-am"),
      theatreAsn("c1", WED, "am", "ts-2026-06-03-am"),
      theatreAsn("c1", THU, "am", "ts-2026-06-04-am"),
      theatreAsn("c1", FRI, "am", "ts-2026-06-05-am"),
    ];

    const { days } = await run();
    assertInvariants(days);
    for (const d of days) {
      expect(d.am.consultantsAvailable).toBe(1); // c2 only
      expect(d.am.seniorTraineesAvailable).toBe(1); // st7
      expect(d.am.soloCapable).toBe(2);
      expect(d.am.unfilled).toBe(0);
      expect(d.am.headroom).toBe(2);
    }
  });

  it("on-call carry-over: ICU on-call duty_type pulls staff from BOTH AM and PM that day", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.rota_assignments = [
      onCallAsn("c1", TUE, "icu_consultant_oncall"),
      onCallAsn("c1", WED, "general_consultant_oncall"),
    ];

    const { byDate } = await run();
    assertInvariants(Array.from(byDate.values()));
    // MON: both free
    expect(byDate.get(MON)!.am.consultantsAvailable).toBe(2);
    expect(byDate.get(MON)!.pm.consultantsAvailable).toBe(2);
    // TUE: c1 on ICU on-call → excluded all day (AM and PM)
    expect(byDate.get(TUE)!.am.consultantsAvailable).toBe(1);
    expect(byDate.get(TUE)!.pm.consultantsAvailable).toBe(1);
    // WED: c1 on general on-call → excluded all day
    expect(byDate.get(WED)!.am.consultantsAvailable).toBe(1);
    expect(byDate.get(WED)!.pm.consultantsAvailable).toBe(1);
    // THU+FRI: released
    expect(byDate.get(THU)!.am.consultantsAvailable).toBe(2);
    expect(byDate.get(FRI)!.pm.consultantsAvailable).toBe(2);
  });

  it("AM theatre on day N does NOT leak into PM on day N or any session on day N+1", async () => {
    fixture.profiles = [CONS("c1"), CONS("c2")];
    fixture.theatre_sessions = [ts(WED, "am")];
    fixture.rota_assignments = [theatreAsn("c1", WED, "am", "ts-2026-06-03-am")];

    const { byDate } = await run();
    assertInvariants(Array.from(byDate.values()));
    // WED AM: c1 on list, only c2 free.
    expect(byDate.get(WED)!.am.consultantsAvailable).toBe(1);
    // WED PM: c1 released for the afternoon.
    expect(byDate.get(WED)!.pm.consultantsAvailable).toBe(2);
    // THU: both free.
    expect(byDate.get(THU)!.am.consultantsAvailable).toBe(2);
    expect(byDate.get(THU)!.pm.consultantsAvailable).toBe(2);
  });

  it("mixed week: leave + theatre + SPA + on-call all combine correctly day-by-day", async () => {
    // 4 consultants, 1 senior trainee.
    fixture.profiles = [
      CONS("c1"), CONS("c2"), CONS("c3"), CONS("c4"), SENIOR("st7"),
    ];
    // 2 AM lists every day, 1 PM list every day.
    fixture.theatre_sessions = [
      ts(MON, "am"), ts(MON, "am", "-b"), ts(MON, "pm"),
      ts(TUE, "am"), ts(TUE, "am", "-b"), ts(TUE, "pm"),
      ts(WED, "am"), ts(WED, "am", "-b"), ts(WED, "pm"),
      ts(THU, "am"), ts(THU, "am", "-b"), ts(THU, "pm"),
      ts(FRI, "am"), ts(FRI, "am", "-b"), ts(FRI, "pm"),
    ];
    fixture.rota_assignments = [
      // MON: c1+c2 cover AM lists, c3 on PM list, c4 SPA AM, st7 free.
      theatreAsn("c1", MON, "am", "ts-2026-06-01-am"),
      theatreAsn("c2", MON, "am", "ts-2026-06-01-am-b"),
      theatreAsn("c3", MON, "pm", "ts-2026-06-01-pm"),
      spaAsn("c4", MON, "am"),
      // TUE: c1 on ICU on-call (out all day); c2+c3 cover AM lists; st7 PM list.
      onCallAsn("c1", TUE, "icu_consultant_oncall"),
      theatreAsn("c2", TUE, "am", "ts-2026-06-02-am"),
      theatreAsn("c3", TUE, "am", "ts-2026-06-02-am-b"),
      theatreAsn("st7", TUE, "pm", "ts-2026-06-02-pm"),
      // WED: nothing scheduled — bare minimum.
      // THU: c4 on SPA both halves.
      spaAsn("c4", THU, "am"),
      spaAsn("c4", THU, "pm"),
      // FRI: c1+c2 supervised pair on same AM list (1 list filled).
      theatreAsn("c1", FRI, "am", "ts-2026-06-05-am", "supervised"),
      theatreAsn("c2", FRI, "am", "ts-2026-06-05-am", "supervised"),
    ];
    // c3 on annual leave WED only.
    fixture.leave_requests = [leave("c3", WED, WED)];

    const { days, byDate } = await run();
    assertInvariants(days);

    // MON AM: free consultants = c5? no — c1,c2 on lists, c4 on SPA, c3 PM-only (still AM-free).
    // Free AM: c3 + st7. SPA: c4. soloCapable=2. Required=2, filled=2 → unfilled=0.
    const monAm = byDate.get(MON)!.am;
    expect(monAm.consultantsAvailable).toBe(1);
    expect(monAm.consultantsOnSpa).toBe(1);
    expect(monAm.seniorTraineesAvailable).toBe(1);
    expect(monAm.soloCapable).toBe(2);
    expect(monAm.unfilled).toBe(0);
    expect(monAm.headroom).toBe(2);

    // MON PM: c3 on list → free c1,c2,c4 (4 - c3). Required=1, filled=1.
    const monPm = byDate.get(MON)!.pm;
    expect(monPm.consultantsAvailable).toBe(3);
    expect(monPm.unfilled).toBe(0);
    expect(monPm.headroom).toBe(3 + monPm.seniorTraineesAvailable);

    // TUE AM: c1 on-call (out all day), c2+c3 on AM lists → free c4. st7 free AM.
    const tueAm = byDate.get(TUE)!.am;
    expect(tueAm.consultantsAvailable).toBe(1);
    expect(tueAm.seniorTraineesAvailable).toBe(1);
    expect(tueAm.required).toBe(2);
    expect(tueAm.unfilled).toBe(0);

    // TUE PM: c1 on-call (out), c2,c3 released from AM list, st7 on PM list → free c2,c3,c4.
    const tuePm = byDate.get(TUE)!.pm;
    expect(tuePm.consultantsAvailable).toBe(3);
    expect(tuePm.seniorTraineesAvailable).toBe(0);
    expect(tuePm.unfilled).toBe(0);

    // WED AM: c3 on leave; nobody covering 2 AM lists → unfilled=2, headroom = 4-2 = 2.
    const wedAm = byDate.get(WED)!.am;
    expect(wedAm.consultantsAvailable).toBe(3); // c1,c2,c4
    expect(wedAm.seniorTraineesAvailable).toBe(1);
    expect(wedAm.soloCapable).toBe(4);
    expect(wedAm.required).toBe(2);
    expect(wedAm.unfilled).toBe(2);
    expect(wedAm.headroom).toBe(2);

    // WED PM: c3 still on leave → 3 consultants + st7 = 4 solo; 1 list unfilled → headroom=3.
    const wedPm = byDate.get(WED)!.pm;
    expect(wedPm.consultantsAvailable).toBe(3);
    expect(wedPm.unfilled).toBe(1);
    expect(wedPm.headroom).toBe(3);

    // THU: c4 on SPA both halves → 3 free consultants + st7; 2 AM lists & 1 PM list unfilled.
    const thuAm = byDate.get(THU)!.am;
    expect(thuAm.consultantsAvailable).toBe(3);
    expect(thuAm.consultantsOnSpa).toBe(1);
    expect(thuAm.unfilled).toBe(2);
    expect(thuAm.headroom).toBe(thuAm.soloCapable - 2);
    expect(thuAm.headroomWithSpa).toBe(thuAm.headroom + 1);

    // FRI AM: c1+c2 supervised on the same list → 1 list filled, 1 unfilled.
    const friAm = byDate.get(FRI)!.am;
    expect(friAm.consultantsAvailable).toBe(2); // c3,c4
    expect(friAm.seniorTraineesAvailable).toBe(1);
    expect(friAm.soloCapable).toBe(3);
    expect(friAm.required).toBe(2);
    expect(friAm.unfilled).toBe(1);
    expect(friAm.headroom).toBe(2);
  });
});
