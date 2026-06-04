import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * End-to-end tests covering REALISTIC CLWRota duty-label variations.
 *
 * The CLWRota Central API surfaces duty labels in a wide range of shapes —
 * different casing, abbreviations, location-only strings, whitespace noise,
 * trust-specific suffixes, and labels split across `shift.name`,
 * `rota.name`, `rota.activity` and `rota.location`. This test file
 * exercises `classifyDutyType` (with the production mapping set) against
 * those variations AND pipes the resulting rows through the robustness
 * engine to confirm the no-headroom-for-theatre invariant still holds.
 *
 * The CLWRota server function file imports server-only modules; we stub
 * those so the helpers can be imported standalone in vitest. Mirrors the
 * setup in robustness.clwrota-payload.test.ts.
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

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      inputValidator: () => ({ handler: () => async () => undefined }),
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
} from "../clwrota.functions";
import { computeRobustness } from "./robustness";

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

interface ClwRotaRow {
  date: string;
  session?: string | null;
  shift?: { name?: string; rota_label?: string } | null;
  person: { local_id: string; grade?: string; training_level?: string | null };
  rota?: { name?: string; activity?: string; location?: string } | null;
  role?: string | null;
}

function ingestClwRota(rows: ClwRotaRow[]) {
  const sessionsByKey = new Map<string, Row>();
  const assignments: Row[] = [];

  for (const row of rows) {
    const session_date = normaliseDate(row.date);
    const session = normaliseSession(row.session ?? null);
    if (!session_date || !session) continue;
    if (session !== "am" && session !== "pm") continue;

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

/* ---------------- Unit: classifyDutyType label variations ---------------- */

describe("classifyDutyType — realistic CLWRota label variations", () => {
  it("theatre labels: room numbers, abbreviations, location-only", () => {
    for (const label of [
      "Theatre 3",
      "THEATRE 14",
      "T7 List",
      "Main OR 2",
      "Day Surgery Unit",
      "Endoscopy Room A",
      "Robotic Theatre",
      "Eye Theatre - List 2",
    ]) {
      expect(classifyDutyType([label], "consultant", null, PROD_MAPPINGS))
        .toBe("theatre");
    }
  });

  it("POAC / pre-op assessment variants classify as theatre (clinical list)", () => {
    for (const label of [
      "POAC clinic",
      "POAC Clinic - Tuesday",
      "Pre-op Assessment",
      "Preassessment Clinic",
      "POA Nurse-led",
    ]) {
      expect(classifyDutyType([label], "consultant", null, PROD_MAPPINGS))
        .toBe("theatre");
    }
  });

  it("Pain clinic variants classify as theatre (clinical list)", () => {
    for (const label of [
      "Pain Clinic",
      "Chronic Pain Clinic",
      "Pain Management - Outpatients",
      "Pain Procedure Room",
    ]) {
      expect(classifyDutyType([label], "consultant", null, PROD_MAPPINGS))
        .toBe("theatre");
    }
  });

  it("SPA (word-boundary match) does NOT collide with substrings", () => {
    expect(classifyDutyType(["SPA"], "consultant", null, PROD_MAPPINGS)).toBe("spa");
    expect(classifyDutyType(["spa"], "consultant", null, PROD_MAPPINGS)).toBe("spa");
    expect(classifyDutyType(["SPA — Audit"], "consultant", null, PROD_MAPPINGS)).toBe("spa");
    expect(classifyDutyType(["Personal SPA"], "consultant", null, PROD_MAPPINGS)).toBe("spa");
    // "Spain", "Spacious" must NOT trigger the SPA mapping (word boundary)…
    expect(classifyDutyType(["Spacious Theatre 1"], "consultant", null, PROD_MAPPINGS))
      .toBe("theatre");
    // …but the hyphenated "on-call" now normalises to "on call" and matches
    // the general_consultant_oncall substring rule (higher priority than SPA).
    expect(classifyDutyType(["Spain on-call cover"], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
  });

  it("on-call variants route by grade + seniority (priority order)", () => {
    // Consultant "On Call" stays general_consultant_oncall, not registrar.
    expect(classifyDutyType(["On Call"], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
    expect(classifyDutyType(["Evening On Call"], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
    // Senior trainee on-call → registrar.
    expect(classifyDutyType(["On Call - Reg"], "trainee", "ST6", PROD_MAPPINGS))
      .toBe("registrar_oncall");
    // Junior trainee on-call → SHO.
    expect(classifyDutyType(["On Call"], "trainee", "CT1", PROD_MAPPINGS))
      .toBe("sho_oncall");
    expect(classifyDutyType(["On Call"], "trainee", "ACCS2", PROD_MAPPINGS))
      .toBe("sho_oncall");
    // ICU consultant takes priority over plain "on call".
    expect(classifyDutyType(["ICU Consultant On Call"], "consultant", null, PROD_MAPPINGS))
      .toBe("icu_consultant_oncall");
  });

  it("obstetrics labels: plain 'obstetric' and 'obs 2nd' both excluded", () => {
    expect(classifyDutyType(["Obstetric Anaesthesia"], "consultant", null, PROD_MAPPINGS))
      .toBe("obstetrics");
    expect(classifyDutyType(["Obstetrics - Labour Ward"], "consultant", null, PROD_MAPPINGS))
      .toBe("obstetrics");
    // "Obs 2nd" without an on-call modifier routes to obstetrics_2nd.
    expect(classifyDutyType(["Obs 2nd cover"], "consultant", null, PROD_MAPPINGS))
      .toBe("obstetrics_2nd");
    expect(classifyDutyType(["OBS 2ND"], "consultant", null, PROD_MAPPINGS))
      .toBe("obstetrics_2nd");
    // "Obs 2nd On Call" hits the higher-priority general_consultant_oncall rule
    // first — still excluded from headroom, just under a different bucket.
    expect(classifyDutyType(["Obs 2nd On Call"], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
  });

  it("ICU trainee labels split by junior/senior", () => {
    expect(classifyDutyType(["ICU Day"], "trainee", "CT2", PROD_MAPPINGS))
      .toBe("icu_trainee");
    expect(classifyDutyType(["ICU Day"], "trainee", "ST5", PROD_MAPPINGS))
      .toBe("icu_ct2_plus");
    expect(classifyDutyType(["ICU Night"], "trainee", "ACCS1", PROD_MAPPINGS))
      .toBe("icu_trainee");
  });

  it("teaching / admin / non-clinical labels do not classify as theatre", () => {
    expect(classifyDutyType(["Teaching"], "consultant", null, PROD_MAPPINGS)).toBe("teaching");
    expect(classifyDutyType(["Departmental Teaching"], "trainee", "ST5", PROD_MAPPINGS))
      .toBe("teaching");
    expect(classifyDutyType(["Admin"], "consultant", null, PROD_MAPPINGS)).toBe("admin");
    expect(classifyDutyType(["Non-clinical time"], "consultant", null, PROD_MAPPINGS))
      .toBe("non_clinical");
  });

  it("'Consultant in Charge' is excluded, but only for consultants", () => {
    expect(classifyDutyType(["Consultant in Charge"], "consultant", null, PROD_MAPPINGS))
      .toBe("consultant_in_charge");
    // Same label on a trainee falls through to theatre (grade filter blocks the rule).
    expect(classifyDutyType(["Consultant in Charge"], "trainee", "ST7", PROD_MAPPINGS))
      .toBe("theatre");
  });

  it("labels split across shift/rota fields all participate in matching", () => {
    // SPA appears in shift.name only.
    expect(classifyDutyType([undefined, "SPA", "Theatre 1", null, null], "consultant", null, PROD_MAPPINGS))
      // priority: ICU>onCall>...>obstetric>in charge>teaching>SPA.
      // No higher-priority match → SPA wins (word match).
      .toBe("spa");
    // ICU consultant in rota.activity wins.
    expect(classifyDutyType([null, null, "Cover Slot", "ICU Consultant Cover", null], "consultant", null, PROD_MAPPINGS))
      .toBe("icu_consultant_oncall");
  });

  it("empty / null labels default to theatre", () => {
    expect(classifyDutyType([], "consultant", null, PROD_MAPPINGS)).toBe("theatre");
    expect(classifyDutyType([null, undefined, ""], "consultant", null, PROD_MAPPINGS))
      .toBe("theatre");
  });

  it("substring patterns tolerate casing, whitespace runs, and hyphen/underscore/slash variants", () => {
    expect(classifyDutyType(["   tHeAtRe   5   "], "consultant", null, PROD_MAPPINGS))
      .toBe("theatre");
    // Single-spaced "On Call" matches.
    expect(classifyDutyType([" On Call "], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
    // Double-spaced "ON  CALL" now normalises to "on call" and matches.
    expect(classifyDutyType(["ON  CALL"], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
    // Tabs + newlines collapse to a single space too.
    expect(classifyDutyType(["On\t\nCall"], "consultant", null, PROD_MAPPINGS))
      .toBe("general_consultant_oncall");
    // Hyphenated, underscored, and slashed variants all match.
    for (const variant of ["on-call", "On-Call", "ON-CALL", "on_call", "on/call", "on--call"]) {
      expect(classifyDutyType([variant], "consultant", null, PROD_MAPPINGS))
        .toBe("general_consultant_oncall");
    }
    // Combined: hyphen + double space + uppercase → still classifies.
    expect(classifyDutyType(["ICU  Consultant-On-Call"], "consultant", null, PROD_MAPPINGS))
      .toBe("icu_consultant_oncall");
    // Trainee variants also pick up "on-call" via the registrar/SHO rules.
    expect(classifyDutyType(["On-Call - Reg"], "trainee", "ST6", PROD_MAPPINGS))
      .toBe("registrar_oncall");
    expect(classifyDutyType(["On_Call"], "trainee", "CT1", PROD_MAPPINGS))
      .toBe("sho_oncall");
  });
});

/* ---------------- End-to-end headroom invariants ---------------- */

describe("CLWRota label variations → no-headroom-for-theatre invariant", () => {
  it("a mix of theatre label spellings all consume the consultant pool", async () => {
    fixture.profiles = [
      profiles.cons("c1"), profiles.cons("c2"), profiles.cons("c3"),
      profiles.cons("c4"), profiles.cons("c5"),
    ];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Theatre 1", location: "T1" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c2", grade: "consultant" },
        rota: { name: "THEATRE 14", location: "T14" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c3", grade: "consultant" },
        rota: { name: "Day Surgery Unit", location: "DSU" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c4", grade: "consultant" },
        rota: { name: "Endoscopy Room A", location: "Endo-A" }, role: "Solo" },
    ]);

    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c5 free
    expect(am.required).toBe(4); // four distinct rooms
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(1);
  });

  it("POAC, Pain, and Preassessment payloads all exclude staff from the free pool", async () => {
    fixture.profiles = [
      profiles.cons("c-poac"), profiles.cons("c-pain"),
      profiles.cons("c-preop"), profiles.cons("c-free"),
    ];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c-poac", grade: "consultant" },
        rota: { name: "POAC Clinic - Tuesday", location: "POAC" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c-pain", grade: "consultant" },
        rota: { name: "Chronic Pain Clinic", location: "Pain-1" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c-preop", grade: "consultant" },
        rota: { name: "Pre-op Assessment", location: "PreOp" }, role: "Solo" },
    ]);

    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // c-free
    expect(am.required).toBe(3);
    expect(am.unfilled).toBe(0);
    expect(am.headroom).toBe(1);
  });

  it("'Spain on-call cover' — hyphenated 'on-call' now classifies as general_consultant_oncall (excluded, not a theatre list)", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Spain on-call cover", location: "Misc" }, role: "Solo" },
    ]);
    const am = await half("am");
    // Word boundary on SPA still rejects "Spain"; the normalised "on call"
    // substring now wins → c1 is excluded all day, no theatre list created.
    expect(am.consultantsAvailable).toBe(1); // c2 free
    expect(am.consultantsOnSpa).toBe(0);
    expect(am.required).toBe(0);
  });

  it("'Personal SPA' label routes to flex pool, not free pool", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Personal SPA" }, role: "Solo" },
    ]);
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1);
    expect(am.consultantsOnSpa).toBe(1);
  });

  it("'Consultant in Charge' label only excludes consultants — same label on a trainee falls through to theatre", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.senior("st7")];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        rota: { name: "Consultant in Charge" }, role: "Solo" },
      { date: DATE, session: "AM",
        person: { local_id: "st7", grade: "trainee", training_level: "ST7" },
        rota: { name: "Consultant in Charge", location: "MisLabelled" }, role: "Solo" },
    ]);
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(0);    // c1 excluded
    expect(am.seniorTraineesAvailable).toBe(0); // st7 on a theatre list (mis-labelled)
    expect(am.required).toBe(1);                // the mis-labelled list counts
    expect(am.unfilled).toBe(0);                // st7 is solo-capable
  });

  it("Obstetric labels (incl. 'Obs 2nd') never count as headroom", async () => {
    fixture.profiles = [
      profiles.cons("c-ob1"), profiles.cons("c-ob2"), profiles.cons("c-free"),
    ];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c-ob1", grade: "consultant" },
        rota: { name: "Obstetric Anaesthesia" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c-ob2", grade: "consultant" },
        rota: { name: "Obs 2nd On Call" }, role: "On Call" },
    ]);
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c-free
    expect(am.required).toBe(0);             // no theatre lists
    expect(am.headroom).toBe(1);
  });

  it("ICU trainee labels (junior + senior) are excluded from the right trainee pools", async () => {
    fixture.profiles = [
      profiles.junior("ct2-icu"), profiles.junior("ct2-free"),
      profiles.senior("st5-icu"), profiles.senior("st5-free"),
    ];
    ingestClwRota([
      { date: DATE, session: "AM",
        person: { local_id: "ct2-icu", grade: "trainee", training_level: "CT2" },
        rota: { name: "ICU Day" }, role: "Solo" },
      { date: DATE, session: "AM",
        person: { local_id: "st5-icu", grade: "trainee", training_level: "ST5" },
        rota: { name: "ICU Day" }, role: "Solo" },
    ]);
    const am = await half("am");
    expect(am.juniorTraineesAvailable).toBe(1); // only ct2-free
    expect(am.seniorTraineesAvailable).toBe(1); // only st5-free
  });

  it("mixed-casing theatre label + properly-spaced 'On Call' still exclude correctly", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2"), profiles.cons("c3")];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        rota: { name: "   tHeAtRe   5   ", location: "T5" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c2", grade: "consultant" },
        rota: { name: " On Call " }, role: "On Call" },
    ]);
    const am = await half("am");
    expect(am.consultantsAvailable).toBe(1); // only c3 free
    expect(am.required).toBe(1);             // T5 list
  });

  it("label split across shift.name (SPA) + rota.name (Theatre) → SPA wins, no theatre list created for that row", async () => {
    fixture.profiles = [profiles.cons("c1"), profiles.cons("c2")];
    ingestClwRota([
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        shift: { name: "SPA" }, rota: { name: "Theatre 1", location: "T1" },
        role: "Solo" },
    ]);
    const am = await half("am");
    // c1 categorised as SPA, not theatre → no theatre_session created.
    expect(am.required).toBe(0);
    expect(am.consultantsAvailable).toBe(1);
    expect(am.consultantsOnSpa).toBe(1);
  });

  it("composite payload exercising 8+ label variations holds headroom invariants", async () => {
    fixture.profiles = [
      profiles.cons("c1"), profiles.cons("c2"), profiles.cons("c3"),
      profiles.cons("c4"), profiles.cons("c5"), profiles.cons("c6"),
      profiles.senior("st7"), profiles.senior("st5-icu"),
      profiles.junior("ct2-icu"), profiles.junior("ct1-free"),
    ];
    ingestClwRota([
      // Theatre, mixed spellings (3 rooms).
      { date: DATE, session: "AM", person: { local_id: "c1", grade: "consultant" },
        rota: { name: "THEATRE 1", location: "T1" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "c2", grade: "consultant" },
        rota: { name: "Day Surgery Unit", location: "DSU" }, role: "Solo" },
      { date: DATE, session: "AM", person: { local_id: "st7", grade: "trainee", training_level: "ST7" },
        rota: { name: "POAC Clinic", location: "POAC" }, role: "Solo" },
      // SPA (flex).
      { date: DATE, session: "AM", person: { local_id: "c3", grade: "consultant" },
        rota: { name: "Personal SPA" }, role: "Solo" },
      // Consultant in charge (excluded).
      { date: DATE, session: "AM", person: { local_id: "c4", grade: "consultant" },
        rota: { name: "Consultant in Charge" }, role: "Solo" },
      // Obstetric 2nd (excluded).
      { date: DATE, session: "AM", person: { local_id: "c5", grade: "consultant" },
        rota: { name: "Obs 2nd On Call" }, role: "On Call" },
      // ICU consultant on-call (excluded all day).
      { date: DATE, session: "AM", person: { local_id: "c6", grade: "consultant" },
        rota: { name: "ICU Consultant On Call" }, role: "On Call" },
      // ICU trainees (excluded).
      { date: DATE, session: "AM",
        person: { local_id: "ct2-icu", grade: "trainee", training_level: "CT2" },
        rota: { name: "ICU Day" }, role: "Solo" },
      { date: DATE, session: "AM",
        person: { local_id: "st5-icu", grade: "trainee", training_level: "ST5" },
        rota: { name: "ICU Day" }, role: "Solo" },
    ]);

    const am = await half("am");
    // Free pool AM: no consultants free; only ct1-free junior trainee left.
    expect(am.consultantsAvailable).toBe(0);
    expect(am.consultantsOnSpa).toBe(1);
    expect(am.seniorTraineesAvailable).toBe(0);
    expect(am.juniorTraineesAvailable).toBe(1);
    // Required = 3 theatre rooms (T1, DSU, POAC).
    expect(am.required).toBe(3);
    // soloCapable = consultantsAvailable + seniorTraineesAvailable = 0.
    expect(am.soloCapable).toBe(0);
    // Two lists filled by solo consultants (c1, c2) + one by a solo senior (st7).
    expect(am.unfilled).toBe(0);
    // headroom = soloCapable - unfilled = 0.
    expect(am.headroom).toBe(0);
    // headroomWithSpa adds the 1 SPA consultant.
    expect(am.headroomWithSpa).toBe(1);
  });
});
