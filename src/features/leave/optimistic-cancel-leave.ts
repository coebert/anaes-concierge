/**
 * Optimistic leave-cancel flow.
 *
 * The user's ask: cancelling a leave request must trigger an *immediate*
 * wellbeing recalculation on the page, without waiting for the server
 * round-trip or the 10-minute wellbeing refetch interval.
 *
 * Strategy:
 *   1. Patch the local `leave.tsx` row arrays synchronously so the row
 *      shows `status = "cancelled"` right away.
 *   2. Patch every cached wellbeing query (`["my-wellbeing", ...]` and
 *      `["admin-wellbeing"]`) so their `useMemo(computeWellbeing, ...)`
 *      picks up the new row without a network fetch. Because
 *      `computeWellbeing` treats status `cancelled` (with a `decided_at`
 *      inside the 90-day window) as a wellbeing driver, the score falls
 *      instantly wherever the wellbeing card is mounted.
 *   3. Fire the Supabase UPDATE.
 *   4. On success, call `invalidateWellbeing(qc)` to reconcile every
 *      wellbeing query with server truth on the next tick.
 *   5. On failure, roll back the row-array and cache patches from step 1/2
 *      and surface the error.
 *
 * The helper is pure w.r.t. React — it takes patcher callbacks — so it
 * can be unit-tested end-to-end without rendering `leave.tsx`.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { LeaveRow } from "@/features/leave/tabs/shared";
import { invalidateWellbeing } from "@/features/wellbeing/invalidate";

export interface SupabaseLike {
  from: (table: string) => {
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

type Patcher = (updater: (rows: LeaveRow[]) => LeaveRow[]) => void;

interface CachedWellbeingLeave {
  id?: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  decided_at?: string | null;
  half_day_start?: string | null;
  half_day_end?: string | null;
}
interface CachedWellbeingData {
  leave: CachedWellbeingLeave[];
  [key: string]: unknown;
}

export interface OptimisticCancelOptions {
  id: string;
  supabase: SupabaseLike;
  qc: QueryClient;
  patchRows: Patcher;
  patchMyLeave: Patcher;
  /** Injectable clock — tests pin this so `decided_at` is deterministic. */
  now?: () => Date;
}

export type OptimisticCancelResult =
  | { ok: true }
  | { ok: false; error: Error };

export async function optimisticCancelLeave(
  opts: OptimisticCancelOptions,
): Promise<OptimisticCancelResult> {
  const { id, supabase, qc, patchRows, patchMyLeave } = opts;
  const now = (opts.now ?? (() => new Date()))();
  const decidedAt = now.toISOString();

  // -- 1/2. Optimistic patches (row arrays + wellbeing caches) ---------
  let rowsSnapshot: LeaveRow[] | null = null;
  let myLeaveSnapshot: LeaveRow[] | null = null;

  const applyRow = (r: LeaveRow): LeaveRow =>
    r.id === id ? { ...r, status: "cancelled", decided_at: decidedAt } : r;

  patchRows((prev) => {
    rowsSnapshot = prev;
    return prev.map(applyRow);
  });
  patchMyLeave((prev) => {
    myLeaveSnapshot = prev;
    return prev.map(applyRow);
  });

  // Snapshot each matching query by its EXACT key so rollback restores
  // the right cache entry even when the key includes extra segments
  // (e.g. `["my-wellbeing", staffId]`).
  const cacheSnapshots: Array<{ key: readonly unknown[]; prev: CachedWellbeingData | undefined }> = [];
  const cache = qc.getQueryCache();
  for (const keyPrefix of [["my-wellbeing"], ["admin-wellbeing"]]) {
    const matches = cache.findAll({ queryKey: keyPrefix });
    for (const q of matches) {
      cacheSnapshots.push({
        key: q.queryKey,
        prev: q.state.data as CachedWellbeingData | undefined,
      });
    }
    qc.setQueriesData<CachedWellbeingData>(
      { queryKey: keyPrefix },
      (old) => {
        if (!old || !Array.isArray(old.leave)) return old;
        return {
          ...old,
          leave: old.leave.map((l) =>
            l.id === id
              ? { ...l, status: "cancelled", decided_at: decidedAt }
              : l,
          ),
        };
      },
    );
  }

  // -- 3. Server round-trip --------------------------------------------
  const { error } = await supabase
    .from("leave_requests")
    .update({ status: "cancelled" })
    .eq("id", id);

  if (error) {
    // -- 5. Roll back everything ---------------------------------------
    if (rowsSnapshot !== null) patchRows(() => rowsSnapshot as LeaveRow[]);
    if (myLeaveSnapshot !== null) patchMyLeave(() => myLeaveSnapshot as LeaveRow[]);
    // Restore the exact prior cache values — including `undefined` if the
    // key wasn't in the cache before we patched it.
    for (const [key, prev] of cacheSnapshots) {
      qc.setQueryData(key as unknown[], prev);
    }
    return { ok: false, error: new Error(error.message) };
  }

  // -- 4. Reconcile with server truth ----------------------------------
  invalidateWellbeing(qc, "leave.cancel");
  return { ok: true };
}
