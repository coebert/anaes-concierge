import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Extended end-to-end fixtures for `computeRobustness`.
 *
 * Goal: stress the consultant-shortfall logic against a wider variety of
 * AM/PM theatre combinations and specialty assignments so future changes
 * to the pipeline can't silently regress staffing classification.
 *
 * Every fixture must satisfy: for every half-day where every ACTIVE,
 * non-emergency theatre list is staffed by a solo-capable clinician,
 * `unfilled === 0` and `risk !== "shortfall"`.
 */

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
    { duty_type: "on_call", category: "excluded" },
    { duty_type: "obstetrics", category: "excluded" },
  ],
  specialties: [],
  theatres: [],
};

function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.order = () => c;
  c.range = () => c;
  c.in = (col: string, vals: unknown[]) => {
    filters.push((r) => vals.includes(r[col]));
    return c;
  };
  c.eq = (col: string, val: unknown) => {
    filters.push((r) => r[col] === val);
    return c;
  };
  c.lte = (col: string, val: unknown) => {
    filters.push((r) => (r[col] as string) <= (val as string));
    return c;
  };
  c.gte = (col: string, val: unknown) => {
    filters.push((r) => (r[col] as string) >= (val as string));
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

// ---------- shared specialty + theatre catalog ----------

const SPEC = {
  ortho: "spec-ortho",
  general: "spec-general",
  ent: "spec-ent",
  gynae: "spec-gynae",
  paeds: "spec-paeds",
  emergency: "spec-emergency",
  cepod: "spec-cepod",
} as const;

const THEATRES = {
  t1: "t-1",
  t2: "t-2",
  t3: "t-3",
  t4: "t-4",
  legacyNhh: "t-legacy-nhh",
  legacyAnnex: "t-legacy-annex",
} as const;

function seedCatalog() {
  fixture.specialties = [
    { id: SPEC.ortho, name: "Orthopaedics" },
    { id: SPEC.general, name: "General Surgery" },
    { id: SPEC.ent, name: "ENT" },
    { id: SPEC.gynae, name: "Gynaecology" },
    { id: SPEC.paeds, name: "Paediatrics" },
    { id: SPEC.emergency, name: "Emergency / CEPOD" },
    { id: SPEC.cepod, name: "CEPOD" },
  ];
  fixture.theatres = [
    { id: THEATRES.t1, active: true },
    { id: THEATRES.t2, active: true },
    { id: THEATRES.t3, active: true },
    { id: THEATRES.t4, active: true },
    { id: THEATRES.legacyNhh, active: false },
    { id: THEATRES.legacyAnnex, active: false },
  ];
}

function makeConsultants(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    grade: "consultant",
    training_level: null,
    ltft_days_off: [],
    active: true,
  }));
}

// ---------- fixture definitions ----------

interface SessionSpec {
  half: "am" | "pm";
  theatreId: string;
  specialtyId?: string | null;
  surgicalConsultant?: string | null;
  /** Whether to assign a solo-capable consultant to this list. */
  staff?: boolean;
}

interface E2EFixture {
  name: string;
  consultants: number;
  /** Sessions per weekday (same pattern repeated across the working week). */
  sessions: SessionSpec[];
  /** Expected `required` count per half (active, non-emergency lists). */
  expected: { am: number; pm: number };
}

const fixtures: E2EFixture[] = [
  {
    name: "single AM theatre per day, one specialty, fully staffed",
    consultants: 2,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
    ],
    expected: { am: 1, pm: 0 },
  },
  {
    name: "single PM theatre per day, one specialty, fully staffed",
    consultants: 2,
    sessions: [
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.general, staff: true },
    ],
    expected: { am: 0, pm: 1 },
  },
  {
    name: "AM and PM in the same theatre, different specialties",
    consultants: 3,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.general, staff: true },
    ],
    expected: { am: 1, pm: 1 },
  },
  {
    name: "four active theatres AM only, four specialties, fully staffed",
    consultants: 6,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      { half: "am", theatreId: THEATRES.t2, specialtyId: SPEC.general, staff: true },
      { half: "am", theatreId: THEATRES.t3, specialtyId: SPEC.ent, staff: true },
      { half: "am", theatreId: THEATRES.t4, specialtyId: SPEC.gynae, staff: true },
    ],
    expected: { am: 4, pm: 0 },
  },
  {
    name: "asymmetric AM=3 / PM=2, mixed specialties, fully staffed",
    consultants: 5,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      { half: "am", theatreId: THEATRES.t2, specialtyId: SPEC.general, staff: true },
      { half: "am", theatreId: THEATRES.t3, specialtyId: SPEC.paeds, staff: true },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.ent, staff: true },
      { half: "pm", theatreId: THEATRES.t2, specialtyId: SPEC.gynae, staff: true },
    ],
    expected: { am: 3, pm: 2 },
  },
  {
    name: "active lists alongside legacy phantom rows (NHH + annex)",
    consultants: 4,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      { half: "am", theatreId: THEATRES.t2, specialtyId: SPEC.general, staff: true },
      { half: "am", theatreId: THEATRES.legacyNhh, specialtyId: SPEC.ortho, staff: false },
      { half: "am", theatreId: THEATRES.legacyAnnex, specialtyId: SPEC.gynae, staff: false },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.ent, staff: true },
      { half: "pm", theatreId: THEATRES.t2, specialtyId: SPEC.paeds, staff: true },
      { half: "pm", theatreId: THEATRES.legacyNhh, specialtyId: SPEC.general, staff: false },
    ],
    expected: { am: 2, pm: 2 },
  },
  {
    name: "emergency lists by specialty_id are excluded from demand",
    consultants: 3,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      { half: "am", theatreId: THEATRES.t2, specialtyId: SPEC.emergency, staff: false },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.general, staff: true },
      { half: "pm", theatreId: THEATRES.t2, specialtyId: SPEC.cepod, staff: false },
    ],
    expected: { am: 1, pm: 1 },
  },
  {
    name: "emergency lists by surgical_consultant hint are excluded from demand",
    consultants: 3,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      {
        half: "am",
        theatreId: THEATRES.t2,
        specialtyId: null,
        surgicalConsultant: "CEPOD on-call team",
        staff: false,
      },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.gynae, staff: true },
      {
        half: "pm",
        theatreId: THEATRES.t2,
        specialtyId: null,
        surgicalConsultant: "Emergency cover",
        staff: false,
      },
    ],
    expected: { am: 1, pm: 1 },
  },
  {
    name: "mixed: active + legacy + emergency on the same half-day",
    consultants: 5,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      { half: "am", theatreId: THEATRES.t2, specialtyId: SPEC.general, staff: true },
      { half: "am", theatreId: THEATRES.t3, specialtyId: SPEC.emergency, staff: false },
      { half: "am", theatreId: THEATRES.legacyNhh, specialtyId: SPEC.ent, staff: false },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.paeds, staff: true },
      { half: "pm", theatreId: THEATRES.t2, specialtyId: SPEC.gynae, staff: true },
      { half: "pm", theatreId: THEATRES.t3, specialtyId: SPEC.ent, staff: true },
      { half: "pm", theatreId: THEATRES.legacyAnnex, specialtyId: SPEC.ortho, staff: false },
    ],
    expected: { am: 2, pm: 3 },
  },
  {
    name: "repeated specialty across multiple theatres in the same half",
    consultants: 4,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: SPEC.ortho, staff: true },
      { half: "am", theatreId: THEATRES.t2, specialtyId: SPEC.ortho, staff: true },
      { half: "am", theatreId: THEATRES.t3, specialtyId: SPEC.ortho, staff: true },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: SPEC.gynae, staff: true },
      { half: "pm", theatreId: THEATRES.t2, specialtyId: SPEC.gynae, staff: true },
    ],
    expected: { am: 3, pm: 2 },
  },
  {
    name: "null specialty lists are still counted as demand",
    consultants: 3,
    sessions: [
      { half: "am", theatreId: THEATRES.t1, specialtyId: null, staff: true },
      { half: "am", theatreId: THEATRES.t2, specialtyId: null, staff: true },
      { half: "pm", theatreId: THEATRES.t1, specialtyId: null, staff: true },
    ],
    expected: { am: 2, pm: 1 },
  },
];

// ---------- shared setup ----------

const WEEK = [
  "2026-06-08", // Mon
  "2026-06-09", // Tue
  "2026-06-10", // Wed
  "2026-06-11", // Thu
  "2026-06-12", // Fri
];
const RANGE_START = WEEK[0];
const RANGE_END = WEEK[WEEK.length - 1];

beforeEach(() => {
  fixture.leave_requests = [];
  fixture.theatre_sessions = [];
  fixture.rota_assignments = [];
  fixture.theatres = [];
  fixture.profiles = [];
  fixture.specialties = [];
});

function applyFixture(f: E2EFixture) {
  seedCatalog();
  fixture.profiles = makeConsultants(f.consultants);

  const sessions: Row[] = [];
  const assignments: Row[] = [];

  WEEK.forEach((date) => {
    // Track consultant rotation per half so a single consultant doesn't end
    // up assigned to two lists in the same half-day.
    const cursor: Record<"am" | "pm", number> = { am: 0, pm: 0 };
    f.sessions.forEach((s, idx) => {
      const tsId = `ts-${date}-${idx}`;
      sessions.push({
        id: tsId,
        session_date: date,
        session: s.half,
        specialty_id: s.specialtyId ?? null,
        surgical_consultant: s.surgicalConsultant ?? null,
        theatre_id: s.theatreId,
      });
      if (s.staff) {
        const staffId = `c${++cursor[s.half]}`;
        assignments.push({
          staff_id: staffId,
          session_date: date,
          session: s.half,
          duty_type: "theatre",
          theatre_session_id: tsId,
        });
      }
    });
  });

  fixture.theatre_sessions = sessions;
  fixture.rota_assignments = assignments;
}

// ---------- the test matrix ----------

describe("computeRobustness — extended end-to-end fixtures", () => {
  for (const f of fixtures) {
    it(`${f.name}: zero shortfall across the working week`, async () => {
      applyFixture(f);

      const { days } = await computeRobustness(RANGE_START, RANGE_END);

      expect(days.map((d) => d.date)).toEqual(WEEK);

      for (const day of days) {
        for (const half of ["am", "pm"] as const) {
          const cap = day[half];
          expect(cap.required, `${day.date} ${half} required`).toBe(
            f.expected[half],
          );
          expect(cap.unfilled, `${day.date} ${half} unfilled`).toBe(0);
          expect(cap.risk, `${day.date} ${half} risk`).not.toBe("shortfall");
          expect(cap.risk, `${day.date} ${half} risk`).not.toBe("spa_required");
          expect(cap.headroom, `${day.date} ${half} headroom`).toBeGreaterThanOrEqual(0);
        }
      }
    });
  }
});
