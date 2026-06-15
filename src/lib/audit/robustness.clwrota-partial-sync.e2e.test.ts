import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * End-to-end test: emergency / CEPOD detection across consecutive CLWRota
 * sync updates that return PARTIAL fields.
 *
 * CLWRota periodically re-syncs `theatre_sessions`. In production we have
 * observed that the upstream payload sometimes omits `specialty_id` or
 * `surgical_consultant` (or both) for an emergency list — for example:
 *
 *   sync #1: specialty_id = emergency, surgical_consultant = "CEPOD team"
 *   sync #2: specialty_id = emergency, surgical_consultant = null
 *   sync #3: specialty_id = null,      surgical_consultant = "CEPOD team"
 *   sync #4: specialty_id = null,      surgical_consultant = null   ← danger
 *
 * The audit's emergency filter is OR-based, so syncs 1–3 must still
 * exclude the list from planned demand. Sync #4 has no remaining signal
 * and the list MUST flip to planned-demand (otherwise we'd be silently
 * hiding a list that genuinely needs a consultant).
 *
 * This test drives `computeRobustness` through a sequence of sync states
 * over the same date and asserts the demand classification at each step.
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

const DATE = "2026-06-08";
const T_ACTIVE = "t-active";
const T_ANCHOR = "t-anchor";
const SPEC_EMERGENCY = "spec-emergency";
const SPEC_ORTHO = "spec-ortho";
const CANDIDATE_ID = "ts-candidate-am";
const ANCHOR_ID = "ts-anchor-am";

/**
 * Replace the CANDIDATE_ID theatre_sessions row to simulate a fresh
 * CLWRota sync update that arrived with a particular field combination.
 * The row's id is stable across syncs (CLWRota keys by its own id), so we
 * mutate in place rather than appending — exactly as the sync upserter
 * does in production.
 */
function applySync(update: {
  specialty_id: string | null;
  surgical_consultant: string | null;
}) {
  fixture.theatre_sessions = (fixture.theatre_sessions as Row[]).filter(
    (t) => t.id !== CANDIDATE_ID,
  );
  fixture.theatre_sessions.push({
    id: CANDIDATE_ID,
    session_date: DATE,
    session: "am",
    specialty_id: update.specialty_id,
    surgical_consultant: update.surgical_consultant,
    theatre_id: T_ACTIVE,
  });
}

beforeEach(() => {
  fixture.leave_requests = [];
  fixture.rota_assignments = [];
  fixture.theatre_sessions = [];
  fixture.profiles = [
    { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    { id: "c2", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
  ];
  fixture.theatres = [
    { id: T_ACTIVE, active: true },
    { id: T_ANCHOR, active: true },
  ];
  fixture.specialties = [
    { id: SPEC_EMERGENCY, name: "Emergency Theatre" },
    { id: SPEC_ORTHO, name: "Orthopaedics" },
  ];

  // Anchor list: one routine staffed AM list so baseline `required` is 1.
  fixture.theatre_sessions.push({
    id: ANCHOR_ID,
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
    theatre_session_id: ANCHOR_ID,
  });
});

async function amRequired() {
  const { days } = await computeRobustness(DATE, DATE);
  return days[0].am;
}

describe("emergency detection — consecutive CLWRota syncs with partial fields", () => {
  it("emergency list stays excluded across syncs that drop one signal at a time", async () => {
    // The candidate is NEVER staffed across any sync. If the audit ever
    // mis-classifies it as planned demand we'll see required=2 and (since
    // the second consultant is also unallocated and free in AM) headroom
    // will shift — `required` is the load-bearing assertion.

    // Sync #1: both signals present and matching.
    applySync({ specialty_id: SPEC_EMERGENCY, surgical_consultant: "CEPOD on-call" });
    let am = await amRequired();
    expect(am.required, "sync#1 both signals").toBe(1);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");

    // Sync #2: hint disappears, specialty_id remains.
    applySync({ specialty_id: SPEC_EMERGENCY, surgical_consultant: null });
    am = await amRequired();
    expect(am.required, "sync#2 specialty only").toBe(1);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");

    // Sync #3: specialty_id disappears, hint reappears.
    applySync({ specialty_id: null, surgical_consultant: "CEPOD overflow" });
    am = await amRequired();
    expect(am.required, "sync#3 hint only").toBe(1);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");

    // Sync #4: hint reworded (case + 'emergency' instead of 'cepod').
    applySync({ specialty_id: null, surgical_consultant: "EMERGENCY cover team" });
    am = await amRequired();
    expect(am.required, "sync#4 hint reworded").toBe(1);
    expect(am.unfilled).toBe(0);

    // Sync #5: specialty restored, hint stays an emergency string.
    applySync({ specialty_id: SPEC_EMERGENCY, surgical_consultant: "Emergency cover team" });
    am = await amRequired();
    expect(am.required, "sync#5 both signals restored").toBe(1);
    expect(am.unfilled).toBe(0);
  });

  it("sync that wipes BOTH signals flips the list to planned demand (must not stay hidden)", async () => {
    // Critical safety property: if an upstream sync genuinely loses every
    // emergency marker, the audit must surface the list as a planned
    // requirement so coordinators see it — not silently exclude it.

    applySync({ specialty_id: SPEC_EMERGENCY, surgical_consultant: "CEPOD" });
    let am = await amRequired();
    expect(am.required).toBe(1); // emergency → excluded

    applySync({ specialty_id: null, surgical_consultant: null });
    am = await amRequired();
    expect(am.required, "both signals wiped → planned demand").toBe(2);
    // c2 is free in AM (only c1 is allocated to the anchor) so the list
    // is counted as required but absorbed by headroom — no shortfall yet,
    // just a true increase in demand surface area.
    expect(am.unfilled).toBe(1);
  });

  it("re-adding either signal in a later sync re-classifies the list as emergency again", async () => {
    // Start at the dangerous state from the previous test.
    applySync({ specialty_id: null, surgical_consultant: null });
    let am = await amRequired();
    expect(am.required).toBe(2);

    // Sync restores specialty_id only.
    applySync({ specialty_id: SPEC_EMERGENCY, surgical_consultant: null });
    am = await amRequired();
    expect(am.required, "specialty restored alone").toBe(1);
    expect(am.unfilled).toBe(0);

    // Next sync drops specialty_id again but supplies the hint.
    applySync({ specialty_id: null, surgical_consultant: "cepod" });
    am = await amRequired();
    expect(am.required, "hint restored alone").toBe(1);
    expect(am.unfilled).toBe(0);
  });

  it("partial sync that downgrades a planned routine list to null fields keeps it as planned demand", async () => {
    // Inverse case: a routine ortho list whose fields get partially
    // erased by a bad sync. It was never emergency to begin with — it
    // must NOT silently become emergency just because both fields are
    // null. (Symmetry guard for the OR-classifier.)
    applySync({ specialty_id: SPEC_ORTHO, surgical_consultant: "Dr Jones — routine" });
    let am = await amRequired();
    expect(am.required, "routine list visible").toBe(2);

    applySync({ specialty_id: SPEC_ORTHO, surgical_consultant: null });
    am = await amRequired();
    expect(am.required, "hint dropped, specialty stays routine").toBe(2);

    applySync({ specialty_id: null, surgical_consultant: null });
    am = await amRequired();
    expect(am.required, "all fields dropped — still planned, not emergency").toBe(2);
  });
});
