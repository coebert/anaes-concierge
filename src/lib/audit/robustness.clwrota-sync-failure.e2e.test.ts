import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * End-to-end test: emergency / CEPOD detection in the robustness audit
 * stays safe when an upstream CLWRota sync fails mid-flight.
 *
 * Failure modes simulated (all are observed in production logs):
 *
 *   A) Malformed JSON  → upstream parser throws; sync aborts BEFORE any
 *      DB write. `theatre_sessions` keeps the previous snapshot intact.
 *
 *   B) Auth failure (401) → CLWRota rejects the bearer token; nothing
 *      is fetched, nothing is written. Same effect as (A) at the DB.
 *
 *   C) Timeout mid-sync → Worker CPU limit kills the request after some
 *      rows have been upserted but others haven't. Result: a mixed state
 *      where SOME rows reflect the new upstream values and others still
 *      hold the previous values (potentially with partial fields).
 *
 * The contract the audit must uphold across all of these:
 *   - Emergency lists are NEVER reclassified as planned demand just
 *     because a sync failed/aborted (no phantom shortfall).
 *   - Planned lists are NEVER silently reclassified as emergency just
 *     because a partial write nulled both signals on a different row.
 *   - The audit re-derives demand purely from the current DB state — it
 *     does not carry forward stale classification across runs.
 *
 * This file does NOT exercise the CLWRota HTTP route directly (that lives
 * behind a Cloudflare Worker with side-effects). It models each failure
 * mode as a `theatre_sessions` state transition and asserts the downstream
 * audit behaviour after every transition — which is where any unsafe
 * regression would actually surface.
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
const T_ANCHOR = "t-anchor";
const T_EMERGENCY = "t-emergency";
const T_ROUTINE = "t-routine";
const SPEC_EMERGENCY = "spec-emergency";
const SPEC_ORTHO = "spec-ortho";
const SPEC_GYNAE = "spec-gynae";

const ANCHOR_ID = "ts-anchor-am";
const EMERGENCY_ID = "ts-emergency-am";
const ROUTINE_ID = "ts-routine-am";

/**
 * Models a CLWRota sync attempt with one of the failure modes above.
 * `apply` is the upstream payload the sync WOULD have written. The mode
 * determines what actually lands in the DB.
 */
type SyncOutcome =
  | { mode: "success"; updates: Record<string, Partial<Row>> }
  | { mode: "malformed_json" }
  | { mode: "auth_error" }
  | { mode: "timeout"; appliedRowIds: string[]; updates: Record<string, Partial<Row>> };

function applySync(outcome: SyncOutcome) {
  if (outcome.mode === "malformed_json" || outcome.mode === "auth_error") {
    // Nothing was written. DB unchanged.
    return;
  }
  const rowsToTouch =
    outcome.mode === "timeout"
      ? outcome.appliedRowIds
      : Object.keys(outcome.updates);

  fixture.theatre_sessions = (fixture.theatre_sessions as Row[]).map((row) => {
    const id = row.id as string;
    if (!rowsToTouch.includes(id)) return row;
    const patch = outcome.updates[id];
    if (!patch) return row;
    return { ...row, ...patch };
  });
}

beforeEach(() => {
  fixture.leave_requests = [];
  fixture.rota_assignments = [];
  fixture.theatre_sessions = [];
  fixture.profiles = [
    { id: "c1", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    { id: "c2", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
    { id: "c3", grade: "consultant", training_level: null, ltft_days_off: [], active: true },
  ];
  fixture.theatres = [
    { id: T_ANCHOR, active: true },
    { id: T_EMERGENCY, active: true },
    { id: T_ROUTINE, active: true },
  ];
  fixture.specialties = [
    { id: SPEC_EMERGENCY, name: "Emergency Theatre" },
    { id: SPEC_ORTHO, name: "Orthopaedics" },
    { id: SPEC_GYNAE, name: "Gynaecology" },
  ];

  // Baseline snapshot — the state after the LAST successful sync. The
  // failure-mode tests below all start here.
  //
  //   anchor   — routine ortho list, staffed by c1 (anchor for `required`)
  //   emergency — CEPOD list with both signals present, unstaffed
  //   routine  — gynae list, staffed by c2
  fixture.theatre_sessions.push(
    {
      id: ANCHOR_ID,
      session_date: DATE,
      session: "am",
      specialty_id: SPEC_ORTHO,
      surgical_consultant: "Dr Anchor",
      theatre_id: T_ANCHOR,
    },
    {
      id: EMERGENCY_ID,
      session_date: DATE,
      session: "am",
      specialty_id: SPEC_EMERGENCY,
      surgical_consultant: "CEPOD on-call",
      theatre_id: T_EMERGENCY,
    },
    {
      id: ROUTINE_ID,
      session_date: DATE,
      session: "am",
      specialty_id: SPEC_GYNAE,
      surgical_consultant: "Dr Routine",
      theatre_id: T_ROUTINE,
    },
  );
  fixture.rota_assignments.push(
    {
      staff_id: "c1",
      session_date: DATE,
      session: "am",
      duty_type: "theatre",
      theatre_session_id: ANCHOR_ID,
    },
    {
      staff_id: "c2",
      session_date: DATE,
      session: "am",
      duty_type: "theatre",
      theatre_session_id: ROUTINE_ID,
    },
  );
});

async function audit() {
  const { days } = await computeRobustness(DATE, DATE);
  return days[0].am;
}

describe("emergency detection — CLWRota sync failures across consecutive updates", () => {
  it("baseline: emergency excluded, routine + anchor required, all staffed", async () => {
    const am = await audit();
    expect(am.required).toBe(2); // anchor + routine
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("malformed JSON aborts before write → DB unchanged, classification holds", async () => {
    // Sync #1 would have demoted the emergency list (both signals nulled),
    // but the JSON parser threw and the transaction never started.
    applySync({ mode: "malformed_json" });
    const am = await audit();
    expect(am.required, "demand after malformed-JSON abort").toBe(2);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("auth/401 failure aborts before write → DB unchanged, classification holds", async () => {
    applySync({ mode: "auth_error" });
    const am = await audit();
    expect(am.required, "demand after auth failure").toBe(2);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("timeout mid-sync that wrote ONLY the emergency row's specialty_id null → hint still keeps it emergency", async () => {
    // Worker died after upserting the emergency row's specialty_id (now
    // null) but before touching anything else. The free-text hint is
    // unchanged → OR-classifier still treats the list as emergency.
    applySync({
      mode: "timeout",
      appliedRowIds: [EMERGENCY_ID],
      updates: { [EMERGENCY_ID]: { specialty_id: null } },
    });
    const am = await audit();
    expect(am.required, "emergency row still excluded via hint").toBe(2);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("timeout mid-sync that wiped BOTH signals on the emergency row → list correctly surfaces as planned demand", async () => {
    // Critical safety property: a partial write that loses every
    // emergency marker must NOT leave the list silently hidden — the
    // audit re-derives from current state and surfaces real demand.
    applySync({
      mode: "timeout",
      appliedRowIds: [EMERGENCY_ID],
      updates: {
        [EMERGENCY_ID]: { specialty_id: null, surgical_consultant: null },
      },
    });
    const am = await audit();
    expect(am.required, "demand surfaces previously-hidden emergency list").toBe(3);
    // c3 is free in AM (only c1, c2 are allocated) so the new gap is
    // absorbed by spare consultant capacity — no shortfall, but the
    // headroom is reduced, which is what coordinators need to see.
    expect(am.unfilled).toBe(1);
    expect(am.headroom).toBeGreaterThanOrEqual(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("timeout that partially wrote a ROUTINE row to null fields → routine stays planned, not reclassified as emergency", async () => {
    // Symmetry guard: a partial write that nulls both fields on a
    // routine list must NOT cause it to be silently treated as emergency
    // (i.e. dropped from demand). The list must remain required.
    applySync({
      mode: "timeout",
      appliedRowIds: [ROUTINE_ID],
      updates: {
        [ROUTINE_ID]: { specialty_id: null, surgical_consultant: null },
      },
    });
    const am = await audit();
    // Routine row still required; c2 is still assigned to it → still filled.
    expect(am.required, "routine list stays planned").toBe(2);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });

  it("consecutive failed syncs (malformed → auth → timeout) leave classification stable until the timeout actually mutates state", async () => {
    // Sync #1: malformed JSON — no change.
    applySync({ mode: "malformed_json" });
    let am = await audit();
    expect(am.required).toBe(2);
    expect(am.unfilled).toBe(0);

    // Sync #2: auth failure — no change.
    applySync({ mode: "auth_error" });
    am = await audit();
    expect(am.required).toBe(2);
    expect(am.unfilled).toBe(0);

    // Sync #3: timeout that managed to drop ONLY the hint on the
    // emergency row before dying. specialty_id still emergency →
    // OR-classifier still excludes it.
    applySync({
      mode: "timeout",
      appliedRowIds: [EMERGENCY_ID],
      updates: { [EMERGENCY_ID]: { surgical_consultant: null } },
    });
    am = await audit();
    expect(am.required, "specialty-only still emergency").toBe(2);
    expect(am.unfilled).toBe(0);

    // Sync #4: a subsequent timeout that finally wipes the remaining
    // specialty_id too. List flips to planned demand — the audit must
    // surface it the moment state actually changes, not before.
    applySync({
      mode: "timeout",
      appliedRowIds: [EMERGENCY_ID],
      updates: { [EMERGENCY_ID]: { specialty_id: null } },
    });
    am = await audit();
    expect(am.required, "all signals now gone → planned").toBe(3);
    expect(am.unfilled).toBe(1);
    expect(am.risk).not.toBe("shortfall"); // c3 absorbs the gap

    // Sync #5: recovery — successful sync re-applies both emergency
    // signals. Classification reverts immediately.
    applySync({
      mode: "success",
      updates: {
        [EMERGENCY_ID]: {
          specialty_id: SPEC_EMERGENCY,
          surgical_consultant: "CEPOD on-call",
        },
      },
    });
    am = await audit();
    expect(am.required, "recovery restores emergency exclusion").toBe(2);
    expect(am.unfilled).toBe(0);
    expect(am.risk).not.toBe("shortfall");
  });
});
