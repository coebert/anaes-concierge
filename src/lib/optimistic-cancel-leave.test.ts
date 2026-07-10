import "@/test/assert-utc-hook";
/**
 * Verifies the optimistic-cancel flow implemented in
 * `src/features/leave/optimistic-cancel-leave.ts`:
 *
 *   1. Local row arrays flip to `status = "cancelled"` BEFORE the Supabase
 *      UPDATE resolves — the user sees the change immediately.
 *   2. Cached wellbeing queries (`my-wellbeing`, `admin-wellbeing`) have
 *      their `leave` array patched in-place, so a `useMemo(computeWellbeing)`
 *      on those caches yields a fresh score without any network fetch.
 *   3. After the server confirms, `invalidateWellbeing` marks both keys
 *      stale so the next fetch reconciles with server truth.
 *   4. If Supabase returns an error, every optimistic patch (local rows +
 *      cache) is rolled back.
 */
import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { optimisticCancelLeave } from "@/features/leave/optimistic-cancel-leave";
import type { LeaveRow } from "@/features/leave/tabs/shared";
import { computeWellbeing } from "@/features/wellbeing/wellbeing-score";

const STAFF = "staff-1";
const LEAVE_ID = "leave-1";
const NOW = new Date("2026-07-10T12:00:00.000Z");

function makeRow(overrides: Partial<LeaveRow> = {}): LeaveRow {
  return {
    id: LEAVE_ID,
    staff_id: STAFF,
    type: "annual",
    status: "pending",
    start_date: "2026-06-20",
    end_date: "2026-06-22",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    conflict_notes: null,
    decision_notes: null,
    decided_at: null,
    created_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Fake Supabase that lets the test control WHEN the UPDATE resolves —
 * essential for asserting "optimistic before server response".
 */
function makeDeferredSupabase() {
  let resolveFn!: (v: { error: { message: string } | null }) => void;
  const pending = new Promise<{ error: { message: string } | null }>((res) => {
    resolveFn = res;
  });
  const calls: Array<{ table: string; patch: unknown; id: string }> = [];

  const supabase = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, val: string) => {
          calls.push({ table, patch, id: val });
          expect(col).toBe("id");
          return pending;
        },
      }),
    }),
  };
  return {
    supabase,
    calls,
    resolveOk: () => resolveFn({ error: null }),
    resolveError: (msg: string) => resolveFn({ error: { message: msg } }),
  };
}

describe("optimisticCancelLeave — immediate wellbeing recalculation", () => {
  it("patches row arrays and wellbeing caches BEFORE the Supabase UPDATE resolves", async () => {
    const qc = new QueryClient();
    const { supabase, resolveOk, calls } = makeDeferredSupabase();

    // Seed the wellbeing caches with the same leave row (still pending).
    const seedLeave = [
      {
        id: LEAVE_ID,
        staff_id: STAFF,
        type: "annual",
        status: "pending",
        start_date: "2026-06-20",
        end_date: "2026-06-22",
        decided_at: null,
      },
    ];
    qc.setQueryData(["my-wellbeing", STAFF], {
      leave: seedLeave,
      assignments: [],
      changes: [],
      exceptions: [],
    });
    qc.setQueryData(["admin-wellbeing"], {
      leave: seedLeave,
      assignments: [],
      changes: [],
      exceptions: [],
    });

    // Local component state (what leave.tsx holds).
    let rows: LeaveRow[] = [makeRow()];
    let mine: LeaveRow[] = [makeRow()];

    // Kick off cancel — do NOT await yet.
    const pending = optimisticCancelLeave({
      id: LEAVE_ID,
      supabase,
      qc,
      patchRows: (u) => {
        rows = u(rows);
      },
      patchMyLeave: (u) => {
        mine = u(mine);
      },
      now: () => NOW,
    });

    // -- BEFORE the server responds --
    // (a) Local rows already show cancelled.
    expect(rows[0].status).toBe("cancelled");
    expect(mine[0].status).toBe("cancelled");
    expect(rows[0].decided_at).toBe(NOW.toISOString());

    // (b) Wellbeing caches show the cancellation, and the recomputed
    //     score has the `leave` driver at 1 (0 before).
    const cachedMine = qc.getQueryData<{ leave: typeof seedLeave }>([
      "my-wellbeing",
      STAFF,
    ])!;
    expect(cachedMine.leave[0].status).toBe("cancelled");
    expect(cachedMine.leave[0].decided_at).toBe(NOW.toISOString());

    const recomputed = computeWellbeing({
      staffId: STAFF,
      now: NOW,
      assignments: [],
      changes: [],
      leave: cachedMine.leave,
      exceptions: [],
    });
    const leaveDriver = recomputed.drivers.find((d) => d.key === "leave")!;
    expect(leaveDriver.value).toBe(1);
    expect(leaveDriver.label).toBe("1 rejected/cancelled leave");

    // (c) The Supabase call was fired but hasn't resolved. The
    // update now stamps `decided_at` alongside `status` so the
    // server row matches what `computeWellbeing` needs to bucket
    // the cancellation into the rolling window.
    expect(calls).toEqual([
      {
        table: "leave_requests",
        patch: { status: "cancelled", decided_at: NOW().toISOString() },
        id: LEAVE_ID,
      },
    ]);

    // Now let the server respond and complete the flow.
    resolveOk();
    const result = await pending;
    expect(result).toEqual({ ok: true });

    // After success, the wellbeing keys are marked stale so the next
    // remount/observer will refetch — server truth wins on reconciliation.
    const cache = qc.getQueryCache();
    expect(cache.find({ queryKey: ["my-wellbeing", STAFF] })!.state.isInvalidated).toBe(true);
    expect(cache.find({ queryKey: ["admin-wellbeing"] })!.state.isInvalidated).toBe(true);
  });

  it("rolls back local rows and cache patches when Supabase returns an error", async () => {
    const qc = new QueryClient();
    const { supabase, resolveError } = makeDeferredSupabase();

    const originalLeave = [
      {
        id: LEAVE_ID,
        staff_id: STAFF,
        type: "annual",
        status: "pending",
        start_date: "2026-06-20",
        end_date: "2026-06-22",
        decided_at: null,
      },
    ];
    qc.setQueryData(["my-wellbeing", STAFF], {
      leave: originalLeave,
      assignments: [],
      changes: [],
      exceptions: [],
    });

    let rows: LeaveRow[] = [makeRow()];
    let mine: LeaveRow[] = [makeRow()];
    const originalRow = rows[0];
    const originalMine = mine[0];

    const pending = optimisticCancelLeave({
      id: LEAVE_ID,
      supabase,
      qc,
      patchRows: (u) => {
        rows = u(rows);
      },
      patchMyLeave: (u) => {
        mine = u(mine);
      },
      now: () => NOW,
    });

    // Server rejects the update.
    resolveError("permission denied");
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("permission denied");

    // Local rows restored to the exact prior objects.
    expect(rows[0]).toEqual(originalRow);
    expect(mine[0]).toEqual(originalMine);
    expect(rows[0].status).toBe("pending");

    // Wellbeing cache restored — the leave row is `pending` again, and
    // recomputing yields a `leave` driver of 0.
    const cached = qc.getQueryData<{ leave: typeof originalLeave }>([
      "my-wellbeing",
      STAFF,
    ])!;
    expect(cached.leave[0].status).toBe("pending");
    expect(cached.leave[0].decided_at).toBeNull();

    const recomputed = computeWellbeing({
      staffId: STAFF,
      now: NOW,
      assignments: [],
      changes: [],
      leave: cached.leave,
      exceptions: [],
    });
    expect(recomputed.drivers.find((d) => d.key === "leave")!.value).toBe(0);
  });

  it("still succeeds when there is no wellbeing cache to patch (fresh session)", async () => {
    // Guards the branch where a user cancels leave before visiting either
    // wellbeing route: setQueriesData receives `undefined` and must be a
    // no-op rather than throwing.
    const qc = new QueryClient();
    const { supabase, resolveOk } = makeDeferredSupabase();

    let rows: LeaveRow[] = [makeRow()];
    let mine: LeaveRow[] = [makeRow()];

    const pending = optimisticCancelLeave({
      id: LEAVE_ID,
      supabase,
      qc,
      patchRows: (u) => {
        rows = u(rows);
      },
      patchMyLeave: (u) => {
        mine = u(mine);
      },
      now: () => NOW,
    });
    expect(rows[0].status).toBe("cancelled");
    expect(mine[0].status).toBe("cancelled");

    resolveOk();
    const result = await pending;
    expect(result).toEqual({ ok: true });
  });
});
