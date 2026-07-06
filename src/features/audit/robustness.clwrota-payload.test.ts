import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Verifies that REAL-LOOKING CLWRota Central API payload shapes (date,
 * session, role and free-text duty labels) map through the production
 * helpers — `normaliseDate`, `normaliseSession`, `normaliseRole`,
 * `classifyDutyType` — into the synthetic `rota_assignments` rows that
 * the robustness engine consumes, AND that the resulting
 * theatre/POAC/pain-clinic assignments hold the no-headroom invariant.
 *
 * The CLWRota server function file imports server-only modules
 * (`@/integrations/supabase/client.server`, `@/integrations/supabase/auth-middleware`,
 * `@tanstack/react-start`). We stub those so the helpers can be imported
 * standalone in vitest.
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
  supabase: { from: (t: string) => makeChain(t as keyof Fixture) },
}));

// Stub server-only imports pulled in by clwrota.functions.ts.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      inputValidator: () => ({
        handler: () => async () => undefined,
      }),
      handler: () => async () => undefined,
    }),
    inputValidator: () => ({ handler: () => async () => undefined }),
    handler: () => async () => undefined,
  }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => makeChain("__none__") },
}));

import {
  normaliseDate,
  normaliseSession,
  normaliseRole,
  classifyDutyType,
  type DutyTypeMappingRow,
  type ResolvedDutyType,
} from "@/features/clwrota/clwrota.functions";
import { isNonWorkingRotaLabel } from "@/lib/clwrota-labels";
import { computeRobustness } from "./robustness";

/* --------------------------- CLWRota payload shape ------------------------ */

/** Minimal CLWRota Central API rota-row shape, modelled on Rotamap's JSON. */
interface ClwRotaRow {
  date: string; // e.g. "2026-06-01" or "01/06/2026"
  session?: string | null; // "AM" | "PM" | "Morning" | ISO like "2026-06-01T08:00:00+01:00"
  shift?: { name?: string; rota_label?: string } | null;
  person: { local_id: string; grade?: string; training_level?: string | null };
  rota?: { name?: string; activity?: string; location?: string } | null;
  role?: string | null; // "Solo", "Trainer", "Supervised", etc.
}

/** Production-equivalent default mappings (mirrors the seed data). */
const PROD_MAPPINGS: DutyTypeMappingRow[] = [
  { duty_type: "icu_consultant_oncall", pattern: "icu consultant", match_type: "substring", grade_filter: "consultant", trainee_seniority_filter: null, priority: 10, active: true },
  { duty_type: "general_consultant_oncall", pattern: "on call", match_type: "substring", grade_filter: "consultant", trainee_seniority_filter: null, priority: 20, active: true },
  { duty_type: "registrar_oncall", pattern: "on call", match_type: "substring", grade_filter: "trainee", trainee_seniority_filter: "senior", priority: 30, active: true },
  { duty_type: "sho_oncall", pattern: "on call", match_type: "substring", grade_filter: "trainee", trainee_seniority_filter: "junior", priority: 40, active: true },
  { duty_type: "icu_trainee", pattern: "icu", match_type: "substring", grade_filter: "trainee", trainee_seniority_filter: "junior", priority: 50, active: true },
  { duty_type: "icu_ct2_plus", pattern: "icu", match_type: "substring", grade_filter: "trainee", trainee_seniority_filter: "senior", priority: 55, active: true },
  { duty_type: "obstetrics_2nd", pattern: "obs 2nd", match_type: "substring", grade_filter: null, trainee_seniority_filter: null, priority: 60, active: true },
  { duty_type: "obstetrics", pattern: "obstetric", match_type: "substring", grade_filter: null, trainee_seniority_filter: null, priority: 70, active: true },
  { duty_type: "consultant_in_charge", pattern: "in charge", match_type: "substring", grade_filter: "consultant", trainee_seniority_filter: null, priority: 80, active: true },
  { duty_type: "teaching", pattern: "teaching", match_type: "substring", grade_filter: null, trainee_seniority_filter: null, priority: 90, active: true },
  { duty_type: "spa", pattern: "spa", match_type: "word", grade_filter: null, trainee_seniority_filter: null, priority: 100, active: true },
  { duty_type: "non_clinical", pattern: "non-clinical", match_type: "substring", grade_filter: null, trainee_seniority_filter: null, priority: 110, active: true },
  { duty_type: "admin", pattern: "admin", match_type: "substring", grade_filter: null, trainee_seniority_filter: null, priority: 120, active: true },
];

/**
 * Translate a list of CLWRota payload rows into synthetic
 * `theatre_sessions` + `rota_assignments` rows, then load them into the
 * robustness fixture. This is the production pipeline in miniature.
 */
function ingestClwRota(rows: ClwRotaRow[]) {
  const sessionsByKey = new Map<string, Row>();
  const assignments: Row[] = [];

  for (const row of rows) {
    const session_date = normaliseDate(row.date);
    const session = normaliseSession(row.session ?? null);
    if (!session_date || !session) continue;
    if (session !== "am" && session !== "pm") {
      // Eve/night assignments map to whole-day exclusions in production;
      // for these tests we focus on AM/PM theatre semantics.
      continue;
    }

    const labels = [
      row.shift?.rota_label, row.shift?.name,
      row.rota?.name, row.rota?.activity, row.rota?.location,
    ];
    const duty: ResolvedDutyType = classifyDutyType(
      labels,
      row.person.grade ?? null,
      row.person.training_level ?? null,
      PROD_MAPPINGS,
    );
    const role = normaliseRole(row.role ?? null);

    let theatre_session_id: string | null = null;
    if (duty === "theatre") {
      // CLWRota uses `rota.location` as the theatre identifier.
      const theatre_id = `room-${(row.rota?.location ?? row.rota?.name ?? "main").toLowerCase()}`;
      const key = `${session_date}|${theatre_id}|${session}`;
      if (!sessionsByKey.has(key)) {
        sessionsByKey.set(key, {
          id: `ts-${sessionsByKey.size + 1}`,
          session_date, session, theatre_id, specialty_id: null,
        });
      }
      theatre_session_id = sessionsByKey.get(key)!.id as string;
    }

    assignments.push({
      staff_id: row.person.local_id,
      session_date, session,
      duty_type: duty,
      theatre_session_id,
      role_on_list: role === "supervising" ? "supervised"
        : role === "supervised" ? "supervisee"
        : "solo",
    });
  }

  fixture.theatre_sessions = Array.from(sessionsByKey.values());
  fixture.rota_assignments = assignments;
}

const DATE = "2026-06-01";

const profiles = {
  cons: (id: string) => ({ id, full_name: id, grade: "consultant", training_level: null, ltft_days_off: [], active: true }),
  senior: (id: string) => ({ id, full_name: id, grade: "trainee", training_level: "ST7", ltft_days_off: [], active: true }),
  junior: (id: string) => ({ id, full_name: id, grade: "trainee", training_level: "CT2", ltft_days_off: [], active: true }),
};

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
  const { days } = await computeRobustness(DATE, DATE, [], { requireRosterEvidence: false });
  expect(days).toHaveLength(1);
  return days[0][side];
}

/* --------------------------- Helper unit tests --------------------------- */

describe("CLWRota payload field mapping helpers", () => {
  it("normaliseSession handles all field shapes Rotamap emits", () => {
    expect(normaliseSession("AM")).toBe("am");
    expect(normaliseSession("pm")).toBe("pm");
    expect(normaliseSession("Morning")).toBe("am");
    expect(normaliseSession("Afternoon")).toBe("pm");
    expect(normaliseSession("Evening")).toBe("eve");
    expect(normaliseSession("Night shift")).toBe("night");
    // ISO timestamp form (Rotamap shift.start_time).
    expect(normaliseSession("2026-06-01T08:00:00+01:00")).toBe("am");
    expect(normaliseSession("2026-06-01T13:30:00+01:00")).toBe("pm");
    expect(normaliseSession("2026-06-01T19:00:00+01:00")).toBe("eve");
    // Bare HH:MM.
    expect(normaliseSession("08:00")).toBe("am");
    expect(normaliseSession("13.30")).toBe("pm");
    expect(normaliseSession(null)).toBeNull();
    expect(normaliseSession("garbage")).toBeNull();
  });

  it("normaliseDate accepts ISO, UK dd/mm/yyyy, and parseable timestamps", () => {
    expect(normaliseDate("2026-06-01")).toBe("2026-06-01");
    expect(normaliseDate("2026-06-01T08:00:00+01:00")).toBe("2026-06-01");
    expect(normaliseDate("01/06/2026")).toBe("2026-06-01");
    expect(normaliseDate("1-6-26")).toBe("2026-06-01");
    expect(normaliseDate(null)).toBeNull();
  });

  it("normaliseRole maps Rotamap role strings to canonical roles", () => {
    expect(normaliseRole("Solo")).toBe("solo");
    expect(normaliseRole("Trainer")).toBe("supervising");
    expect(normaliseRole("Supervisor")).toBe("supervising");
    expect(normaliseRole("Supervised")).toBe("supervised");
    expect(normaliseRole("Trainee")).toBe("supervised");
    expect(normaliseRole("On Call")).toBe("on_call");
    expect(normaliseRole("Teaching")).toBe("teaching");
    expect(normaliseRole("Admin")).toBe("admin_session");
    expect(normaliseRole(null)).toBe("solo");
  });

  it("classifyDutyType uses the configured mappings (priority order)", () => {
    expect(classifyDutyType(["ICU Consultant On Call"], "consultant", null, PROD_MAPPINGS))
      .toBe("icu_consultant_oncall");
    expect(classifyDutyType(["General On Call"], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
    expect(classifyDutyType(["On Call"], "trainee", "ST7", PROD_MAPPINGS))
      .toBe("registrar_oncall");
    expect(classifyDutyType(["On Call"], "trainee", "CT2", PROD_MAPPINGS))
      .toBe("sho_oncall");
    expect(classifyDutyType(["Obstetrics"], "consultant", null, PROD_MAPPINGS))
      .toBe("obstetrics");
    expect(classifyDutyType(["Obs 2nd"], "consultant", null, PROD_MAPPINGS))
      .toBe("obstetrics_2nd");
    expect(classifyDutyType(["SPA"], "consultant", null, PROD_MAPPINGS))
      .toBe("spa");
    expect(classifyDutyType(["Teaching"], "consultant", null, PROD_MAPPINGS))
      .toBe("teaching");
    // Default fall-through.
    expect(classifyDutyType(["Theatre 3"], "consultant", null, PROD_MAPPINGS))
      .toBe("theatre");
    expect(classifyDutyType(["POAC clinic"], "consultant", null, PROD_MAPPINGS))
      .toBe("theatre");
    expect(classifyDutyType(["Pain clinic"], "consultant", null, PROD_MAPPINGS))
      .toBe("theatre");
  });

  it("detects CLWRota off/day-off placeholders as non-working labels", () => {
    expect(isNonWorkingRotaLabel(["Off Day"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Surgeon: Off"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Surgeon: Masood? off"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Theatre 3", "Pain clinic"])).toBe(false);
  });
});

/* ---------------- End-to-end: payload → assignments → headroom ---------- */

describe("CLWRota payload → robustness no-headroom-for-theatre invariant", () => {
  it("an AM theatre row pulls the consultant out of the AM free pool", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      {
        date: DATE, session: "AM",
        person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Theatre 3", location: "T3" }, role: "Solo",
      },
    ]);

    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c2
    expect(am.soloCapable).toBe(1);
    expect(am.unfilled).toBe(0); // list filled
    expect(am.headroom).toBe(1);
  });

  it("Rotamap ISO timestamp session field still produces correct AM/PM exclusion", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      {
        date: "2026-06-01T13:30:00+01:00",
        session: "2026-06-01T13:30:00+01:00",
        person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Theatre 5", location: "T5" }, role: "Solo",
      },
    ]);

    expect((await half("am")).consultantsAvailable).toBe(2);
    expect((await half("pm")).consultantsAvailable).toBe(1);
  });

  it("UK date format (dd/mm/yyyy) routes to the right session_date", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      {
        date: "01/06/2026", session: "AM",
        person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Theatre 1", location: "T1" }, role: "Solo",
      },
    ]);
    expect((await half("am")).consultantsAvailable).toBe(1);
  });

  it("POAC and pain-clinic CLWRota rows behave as theatre (no headroom for those staff)", async () => {
    fixture.profiles = [
      profiles.cons("c-poac"), profiles.cons("c-pain"), profiles.cons("c-free"),
    ];
    ingestClwRota([
      {
        date: DATE, session: "AM",
        person: { local_id: "c-poac", grade: "consultant" },
        rota: { name: "POAC clinic", location: "POAC" }, role: "Solo",
      },
      {
        date: DATE, session: "AM",
        person: { local_id: "c-pain", grade: "consultant" },
        rota: { name: "Pain clinic", location: "Pain-1" }, role: "Solo",
      },
    ]);
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c-free
    expect(am.required).toBe(2); // POAC + Pain rooms
    expect(am.unfilled).toBe(0);
  });

  it("Rotamap 'Trainer' + 'Supervised' rows on the same list: both excluded, list filled once", async () => {
    fixture.profiles = [
      profiles.cons("c-sup"), profiles.cons("c-free"),
      profiles.senior("st7-train"), profiles.senior("st7-free"),
    ];
    ingestClwRota([
      {
        date: DATE, session: "AM",
        person: { local_id: "c-sup", grade: "consultant" },
        rota: { name: "Theatre 2", location: "T2" }, role: "Trainer",
      },
      {
        date: DATE, session: "AM",
        person: { local_id: "st7-train", grade: "trainee", training_level: "ST7" },
        rota: { name: "Theatre 2", location: "T2" }, role: "Supervised",
      },
    ]);
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // c-free
    expect(am.seniorTraineesAvailable).toBe(1); // st7-free
    expect(am.soloCapable).toBe(2);
    expect(am.required).toBe(1);
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(2);
  });

  it("SPA payload row routes through 'spa' duty_type → flex cover only, not free", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      {
        date: DATE, session: "AM",
        person: { local_id: "c1", grade: "consultant" },
        rota: { name: "SPA", location: "Office" }, role: "Solo",
      },
    ]);
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1);
    expect(am.consultantsOnSpa).toBe(1);
  });

  it("ICU consultant on-call row excludes the consultant for the whole day", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      {
        date: DATE, session: "AM",
        person: { local_id: "c1", grade: "consultant" },
        rota: { name: "ICU Consultant On Call", location: "ICU" },
        role: "On Call",
      },
    ]);
    const am = await half("am");
    const pm = await half("pm");
    expect(am.consultantsAvailable).toBe(1);
    expect(pm.consultantsAvailable).toBe(1);
  });

  it("Senior trainee 'On Call' row maps to registrar_oncall (excluded all day)", async () => {
    fixture.profiles = [profiles.senior("st7-a"), profiles.senior("st7-b")];
    ingestClwRota([
      {
        date: DATE, session: "AM",
        person: { local_id: "st7-a", grade: "trainee", training_level: "ST7" },
        rota: { name: "On Call" }, role: "On Call",
      },
    ]);
    expect((await half("am")).seniorTraineesAvailable).toBe(1);
    expect((await half("pm")).seniorTraineesAvailable).toBe(1);
  });

  it("Mixed realistic payload: theatre + SPA + on-call composes to correct headroom", async () => {
    fixture.profiles = [
      profiles.cons("c1"), profiles.cons("c2"), profiles.cons("c3"),
      profiles.cons("c4"), profiles.senior("st7"), profiles.junior("ct2"),
    ];
    ingestClwRota([
      // 3 AM theatre lists in different rooms.
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Theatre 1", location: "T1" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c2", grade: "consultant" },
        rota: { name: "Theatre 2", location: "T2" }, role: "Trainer" },
      { date: DATE, session: "AM", person: { local_id: "ct2", grade: "trainee", training_level: "CT2" },
        rota: { name: "Theatre 2", location: "T2" }, role: "Supervised" },
      { date: DATE, session: "AM", person: { local_id: "st7", grade: "trainee", training_level: "ST7" },
        rota: { name: "POAC clinic", location: "POAC" }, role: "Solo" },
      // c3 on SPA AM.
      { date: DATE, session: "AM", person: { local_id: "c3", grade: "consultant" },
        rota: { name: "SPA" }, role: "Solo" },
      // c4 ICU consultant on-call (whole day).
      { date: DATE, session: "AM", person: { local_id: "c4", grade: "consultant" },
        rota: { name: "ICU Consultant On Call" }, role: "On Call" },
    ]);

    const am = await half("am");
    // Available consultants (AM): none — c1,c2 on lists, c3 on SPA, c4 on-call.
    expect(am.consultantsAvailable).toBe(0);
    expect(am.consultantsOnSpa).toBe(1);
    expect(am.seniorTraineesAvailable).toBe(0); // st7 on POAC list
    expect(am.juniorTraineesAvailable).toBe(0); // ct2 supervised
    expect(am.soloCapable).toBe(0);
    // Required = 3 distinct theatre_sessions (T1, T2, POAC).
    expect(am.required).toBe(3);
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(0);
    expect(am.headroomWithSpa).toBe(1); // 1 SPA consultant could be redeployed
  });
});
