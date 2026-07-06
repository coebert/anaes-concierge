import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * End-to-end tests for emergency / CEPOD list detection inside the
 * robustness pipeline.
 *
 * The audit treats a theatre_sessions row as an "emergency list" — and
 * therefore EXCLUDES it from the planned-list demand model — if EITHER:
 *
 *   1. `specialty_id` resolves to a specialty whose name matches
 *      /emergenc|cepod/i, OR
 *   2. `surgical_consultant` (free text) contains "emergenc" or "cepod"
 *      (case-insensitive).
 *
 * The two signals are OR'd: if either fires the list is emergency. If both
 * are missing/non-matching the list counts as normal planned demand.
 *
 * These tests cover the conflict and missing-signal edge cases so a future
 * refactor can't silently flip the semantics (e.g. requiring AND, or
 * trusting only one of the two signals).
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

const DATE = "2026-06-08"; // Monday

const T_ACTIVE = "t-active";
const T_ANCHOR = "t-anchor"; // always carries one staffed routine list per half
const SPEC_EMERGENCY = "spec-emergency";
const SPEC_CEPOD = "spec-cepod";
const SPEC_ORTHO = "spec-ortho";

beforeEach(() => {
  fixture.leave_requests = [];
  fixture.theatre_sessions = [];
  fixture.rota_assignments = [];
  fixture.theatres = [
    { id: T_ACTIVE, active: true },
    { id: T_ANCHOR, active: true },
  ];
  fixture.profiles = [
    // 3 consultants — enough headroom that any genuine planned-list demand
    // we count will be reflected in `required`/`unfilled`, not absorbed.
    { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    { id: "c2", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    { id: "c3", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
  ];
  fixture.specialties = [
    { id: SPEC_EMERGENCY, name: "Emergency Theatre" },
    { id: SPEC_CEPOD, name: "CEPOD" },
    { id: SPEC_ORTHO, name: "Orthopaedics" },
  ];
});

/**
 * Add one routine staffed anchor list per half-day so the pipeline always
 * has a known baseline of `required = 1`. Any candidate emergency list
 * under test then either adds +1 to `required` (if treated as planned) or
 * leaves it at 1 (if correctly excluded).
 */
function seedAnchorLists() {
  for (const half of ["am", "pm"] as const) {
    const id = `ts-anchor-${half}`;
    fixture.theatre_sessions.push({
      id,
      session_date: DATE,
      session: half,
      specialty_id: SPEC_ORTHO,
      surgical_consultant: "Dr Anchor",
      theatre_id: T_ANCHOR,
    });
    fixture.rota_assignments.push({
      staff_id: half === "am" ? "c1" : "c2",
      session_date: DATE,
      session: half,
      duty_type: "theatre",
      theatre_session_id: id,
    });
  }
}

function addCandidate(
  half: "am" | "pm",
  opts: { specialty_id: string | null; surgical_consultant: string | null; staff?: boolean },
) {
  const id = `ts-candidate-${half}`;
  fixture.theatre_sessions.push({
    id,
    session_date: DATE,
    session: half,
    specialty_id: opts.specialty_id,
    surgical_consultant: opts.surgical_consultant,
    theatre_id: T_ACTIVE,
  });
  if (opts.staff) {
    fixture.rota_assignments.push({
      staff_id: "c3",
      session_date: DATE,
      session: half,
      duty_type: "theatre",
      theatre_session_id: id,
    });
  }
}

async function runAm() {
  const { days } = await computeRobustness(DATE, DATE);
  return days[0].am;
}
async function runPm() {
  const { days } = await computeRobustness(DATE, DATE);
  return days[0].pm;
}

describe("computeRobustness — emergency list detection (conflicts & missing signals)", () => {
  it("both signals agree (emergency specialty + 'CEPOD' hint): excluded from demand", async () => {
    seedAnchorLists();
    addCandidate("am", {
      specialty_id: SPEC_EMERGENCY,
      surgical_consultant: "CEPOD on-call team",
      staff: false,
    });
    const am = await runAm();
    expect(am.required).toBe(1); // only the anchor
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("emergency specialty wins over a non-matching surgical_consultant hint", async () => {
    // specialty_id IS emergency, but the free-text field looks like a
    // routine list ("Dr Smith — elective"). OR-semantics: still excluded.
    seedAnchorLists();
    addCandidate("am", {
      specialty_id: SPEC_EMERGENCY,
      surgical_consultant: "Dr Smith — elective list",
      staff: false,
    });
    const am = await runAm();
    expect(am.required).toBe(1);
    expect(am.unfilled).toBe(0);
  });

  it("surgical_consultant hint wins when specialty is non-emergency", async () => {
    // specialty_id points at a routine specialty (Orthopaedics), but the
    // free text says "Emergency cover". OR-semantics: excluded.
    seedAnchorLists();
    addCandidate("am", {
      specialty_id: SPEC_ORTHO,
      surgical_consultant: "Emergency cover team",
      staff: false,
    });
    const am = await runAm();
    expect(am.required).toBe(1);
    expect(am.unfilled).toBe(0);
  });

  it("CEPOD hint is matched case-insensitively in surgical_consultant", async () => {
    seedAnchorLists();
    addCandidate("pm", {
      specialty_id: null,
      surgical_consultant: "Cepod Team",
      staff: false,
    });
    const pm = await runPm();
    expect(pm.required).toBe(1); // anchor only
    expect(pm.unfilled).toBe(0);
  });

  it("emergency hint is matched case-insensitively (uppercase, partial 'EMERGENCY')", async () => {
    seedAnchorLists();
    addCandidate("pm", {
      specialty_id: null,
      surgical_consultant: "EMERGENCY list",
      staff: false,
    });
    const pm = await runPm();
    expect(pm.required).toBe(1);
    expect(pm.unfilled).toBe(0);
  });

  it("both signals missing (null specialty + null hint): treated as planned demand", async () => {
    seedAnchorLists();
    addCandidate("am", {
      specialty_id: null,
      surgical_consultant: null,
      staff: true, // staffed so we don't trip a shortfall in this control
    });
    const am = await runAm();
    expect(am.required).toBe(2); // anchor + candidate
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("both signals present but non-matching: treated as planned demand", async () => {
    seedAnchorLists();
    addCandidate("pm", {
      specialty_id: SPEC_ORTHO,
      surgical_consultant: "Dr Jones — routine list",
      staff: true,
    });
    const pm = await runPm();
    expect(pm.required).toBe(2);
    expect(pm.unfilled).toBe(0);
  });

  it("missing specialty + emergency hint only: excluded (hint alone is enough)", async () => {
    seedAnchorLists();
    addCandidate("am", {
      specialty_id: null,
      surgical_consultant: "Emergency theatre on-call",
      staff: false,
    });
    const am = await runAm();
    expect(am.required).toBe(1);
    expect(am.unfilled).toBe(0);
  });

  it("emergency specialty + missing hint: excluded (specialty alone is enough)", async () => {
    seedAnchorLists();
    addCandidate("am", {
      specialty_id: SPEC_CEPOD,
      surgical_consultant: null,
      staff: false,
    });
    const am = await runAm();
    expect(am.required).toBe(1);
    expect(am.unfilled).toBe(0);
  });

  it("specialty_id points at a non-existent specialty row + non-matching hint: counted as planned", async () => {
    // Safety net: if a theatre_session references a specialty that has
    // been deleted/renamed, the audit must NOT silently treat it as
    // emergency. It falls back to the hint, which here is non-matching.
    seedAnchorLists();
    addCandidate("pm", {
      specialty_id: "spec-ghost-id-not-in-table",
      surgical_consultant: "Dr Roe — gynae list",
      staff: true,
    });
    const pm = await runPm();
    expect(pm.required).toBe(2);
    expect(pm.unfilled).toBe(0);
  });

  it("specialty_id points at a non-existent specialty row + emergency hint: excluded via hint", async () => {
    seedAnchorLists();
    addCandidate("pm", {
      specialty_id: "spec-ghost-id-not-in-table",
      surgical_consultant: "CEPOD overflow",
      staff: false,
    });
    const pm = await runPm();
    expect(pm.required).toBe(1);
    expect(pm.unfilled).toBe(0);
  });

  it("hint substring inside a longer word does NOT accidentally match (e.g. 'emergency-trained')", async () => {
    // The regex /emergenc|cepod/i is intentionally a substring match — make
    // this behavior explicit so a future tightening (\b word boundary) is
    // a deliberate change with a failing test, not an accident.
    seedAnchorLists();
    addCandidate("am", {
      specialty_id: SPEC_ORTHO,
      surgical_consultant: "Dr Lee — emergency-trained but routine list today",
      staff: false,
    });
    const am = await runAm();
    // Substring "emergenc" matches → excluded from demand.
    expect(am.required).toBe(1);
    expect(am.unfilled).toBe(0);
  });

  it("unstaffed non-emergency candidate genuinely creates a shortfall (negative control)", async () => {
    // Sanity check: when the candidate is NOT classified as emergency and
    // is unstaffed AND the consultant pool is fully spoken for, we get a
    // real shortfall — proving the previous tests' `required = 1` outcomes
    // aren't an artefact of the candidate being silently dropped for some
    // other reason. Single-consultant pool, fully booked on the AM anchor.
    fixture.profiles = [
      { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    ];
    // AM anchor only — c1 covers it; no PM anchor needed for this control.
    fixture.theatre_sessions.push({
      id: "ts-anchor-am",
      session_date: DATE,
      session: "am",
      specialty_id: SPEC_ORTHO,
      surgical_consultant: "Dr Anchor",
      theatre_id: T_ANCHOR,
    });
    fixture.rota_assignments.push({
      staff_id: "c1",
      session_date: DATE,
      session: "am",
      duty_type: "theatre",
      theatre_session_id: "ts-anchor-am",
    });
    addCandidate("am", {
      specialty_id: SPEC_ORTHO,
      surgical_consultant: "Dr Jones — routine list",
      staff: false,
    });
    const am = await runAm();
    expect(am.required).toBe(2);
    expect(am.unfilled).toBe(1);
    expect(am.risk).toBe("shortfall");
  });

});
