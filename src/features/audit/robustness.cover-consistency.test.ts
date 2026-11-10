import { describe, it, expect, vi, beforeEach } from "vitest";

// Synthetic staff only. A tiny fake of the query builder that honours the
// eq / lte / gte / in filters used by the cover calculations, and can fail a
// chosen table.
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const failing = new Set<string>();

function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.order = () => c;
  c.range = () => c;
  c.limit = () => c;
  c.eq = (col: string, v: unknown) => (filters.push((r) => !(col in r) || r[col] === v), c);
  c.lte = (col: string, v: string) => (filters.push((r) => !(col in r) || String(r[col]) <= v), c);
  c.gte = (col: string, v: string) => (filters.push((r) => !(col in r) || String(r[col]) >= v), c);
  c.in = (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), c);
  c.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(
      failing.has(table)
        ? { data: null, error: { message: `synthetic ${table} failure` } }
        : { data: (db[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null },
    ).then(ok, bad);
  return c;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (t: string) => chain(t) },
}));

import { computeRobustness, loadDayDetail, type HalfBreakdown } from "./robustness";

const DATE = "2030-01-07"; // Monday
const prof = (id: string, grade: string | null, training_level: string | null = null) => ({
  id,
  full_name: `Synth ${id}`,
  grade,
  training_level,
  ltft_days_off: [],
  active: true,
});
const asn = (id: string, staff_id: string, session: string, duty_type: string, ts: string | null = null) => ({
  id,
  staff_id,
  session_date: DATE,
  session,
  duty_type,
  theatre_session_id: ts,
  role_on_list: ts ? "solo" : null,
});

beforeEach(() => {
  failing.clear();
  db.duty_type_pool_rules = [
    { duty_type: "theatre", category: "clinical_list" },
    { duty_type: "spa", category: "flex" },
    { duty_type: "admin", category: "excluded" },
  ];
  db.specialties = [
    { id: "sp-g", name: "General" },
    { id: "sp-em", name: "Emergency" },
  ];
  db.theatres = [{ id: "th1", name: "Theatre 1", active: true }];
  db.theatre_sessions = [
    { id: "ts1", session_date: DATE, session: "am", specialty_id: "sp-g", surgical_consultant: null, theatre_id: "th1" },
    { id: "ts2", session_date: DATE, session: "pm", specialty_id: "sp-g", surgical_consultant: null, theatre_id: "th1" },
    { id: "ts3", session_date: DATE, session: "am", specialty_id: "sp-em", surgical_consultant: null, theatre_id: "th1" },
  ];
  db.profiles = [
    prof("c1", "consultant"),
    prof("c2", "consultant"),
    prof("c3", "consultant"), // no rota entry → not on duty
    prof("c4", "consultant"), // only an emergency list → not rostered for planned cover
    prof("t8", "trainee", "ST8"),
    prof("t5", "trainee", "ST5"),
    prof("s1", "sas"),
    prof("u1", null),
    prof("t7", "trainee", "ST7"), // on leave
  ];
  db.rota_assignments = [
    asn("a1", "c1", "am", "theatre", "ts1"),
    asn("a2", "c2", "am", "spa"),
    asn("a3", "c4", "am", "theatre", "ts3"),
    asn("a4", "t8", "pm", "theatre", "ts2"),
    asn("a5", "t5", "am", "admin"),
    asn("a6", "s1", "am", "spa"),
    asn("a7", "u1", "pm", "spa"),
    asn("a8", "t7", "am", "spa"),
  ];
  db.leave_requests = [
    { id: "l1", staff_id: "t7", type: "annual", status: "approved", start_date: DATE, end_date: DATE },
  ];
  db.trainee_targets = [];
});

const soloIn = (b: HalfBreakdown) => b.entries.filter((e) => e.countsToSolo).length;
const cat = (b: HalfBreakdown, id: string) => b.entries.find((e) => e.staffId === id)?.category;

describe("cover rules — one set of semantics across overview and day detail", () => {
  it("day-detail breakdown rolls up to exactly the overview's solo-capable count (AM and PM)", async () => {
    const { days } = await computeRobustness(DATE, DATE);
    const d = await loadDayDetail(DATE);
    expect(days[0].am.soloCapable).toBe(1); // ST8 free in the AM
    expect(days[0].pm.soloCapable).toBe(1); // consultant free after SPA in the PM
    expect(d.am.soloCapable).toBe(days[0].am.soloCapable);
    expect(soloIn(d.amBreakdown)).toBe(days[0].am.soloCapable);
    expect(soloIn(d.pmBreakdown)).toBe(days[0].pm.soloCapable);
    expect(d.amBreakdown.entries.filter((e) => e.category === "on_spa").length).toBe(
      days[0].am.consultantsOnSpa,
    );
  });

  it("ST8 is solo-capable in both views; ST5 and SAS are not", async () => {
    const d = await loadDayDetail(DATE);
    expect(cat(d.amBreakdown, "t8")).toBe("free_senior_trainee");
    expect(d.amBreakdown.entries.find((e) => e.staffId === "t8")?.countsToSolo).toBe(true);
    expect(cat(d.amBreakdown, "s1")).toBe("free_sas");
    expect(cat(d.amBreakdown, "t5")).toBe("on_excluded_duty");
  });

  it("people with no rota entry (or only an emergency list) are not rostered, not free", async () => {
    const d = await loadDayDetail(DATE);
    expect(cat(d.amBreakdown, "c3")).toBe("not_rostered");
    expect(cat(d.amBreakdown, "c4")).toBe("not_rostered");
    expect(cat(d.pmBreakdown, "u1")).toBe("free_other");
    expect(cat(d.amBreakdown, "t7")).toBe("on_leave");
  });

  it("emergency lists are flagged and not counted as planned demand", async () => {
    const { days } = await computeRobustness(DATE, DATE);
    const d = await loadDayDetail(DATE);
    expect(days[0].am.required).toBe(1);
    expect(d.sessions.find((s) => s.id === "ts3")?.emergency).toBe(true);
    expect(d.sessions.find((s) => s.id === "ts1")?.emergency).toBe(false);
  });
});

describe("duty_type_pool_rules — failure vs successful empty config", () => {
  it("a failed read is an error (Retry), never a number from built-in defaults", async () => {
    failing.add("duty_type_pool_rules");
    await expect(computeRobustness(DATE, DATE)).rejects.toThrow(/Duty categories couldn't be loaded/);
    await expect(loadDayDetail(DATE)).rejects.toThrow(/Duty categories couldn't be loaded/);
  });

  it("a successful empty config uses the built-in categories and says so", async () => {
    db.duty_type_pool_rules = [];
    const r = await computeRobustness(DATE, DATE);
    expect(r.poolRulesSource).toBe("defaults");
    // Built-in: admin is excluded, spa is flex, theatre is a clinical list.
    expect(r.days[0].am.consultantsOnSpa).toBe(1);
    expect(r.days[0].am.soloCapable).toBe(1);
  });

  it("configured rules are reported as configured", async () => {
    expect((await computeRobustness(DATE, DATE)).poolRulesSource).toBe("configured");
  });

  it("other reads in the same calculations also fail loudly", async () => {
    failing.add("theatres");
    await expect(computeRobustness(DATE, DATE)).rejects.toThrow(/theatres/);
    failing.clear();
    failing.add("trainee_targets");
    await expect(loadDayDetail(DATE)).rejects.toThrow(/trainee_targets/);
    failing.clear();
    failing.add("leave_requests");
    await expect(loadDayDetail(DATE)).rejects.toThrow();
  });
});
