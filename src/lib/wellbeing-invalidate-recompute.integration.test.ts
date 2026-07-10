import "@/test/assert-utc-hook";
/**
 * Pipeline contract: after a leave row transitions to `rejected` or
 * `cancelled`, calling `invalidateWellbeing(qc)` MUST cause the wellbeing
 * queries to re-run `computeWellbeing` against the new data and produce a
 * result that reflects the change (the "rejected/cancelled leave" driver
 * count increments, and the overall score drops).
 *
 * Complements `wellbeing-refresh-after-mutations.integration.test.tsx`
 * which asserts the queries *refetch*. This test asserts the *recomputed
 * result differs* — a regression that memoises computeWellbeing on stale
 * inputs, or that invalidates the wrong key so the fresh fetch never
 * happens, fails here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import {
  computeWellbeing,
  type LeaveLite,
  type WellbeingResult,
} from "@/features/wellbeing/wellbeing-score";

const STAFF = "staff-1";
const NOW = new Date("2026-07-10T00:00:00.000Z");

// Mutable fake DB the queryFns read on every fetch.
let leaveRows: LeaveLite[] = [];

function seedPending() {
  leaveRows = [
    {
      staff_id: STAFF,
      status: "pending",
      type: "annual",
      start_date: "2026-06-20",
      end_date: "2026-06-22",
      decided_at: null,
    },
  ];
}

function updateLeaveStatus(newStatus: "rejected" | "cancelled") {
  leaveRows = leaveRows.map((l) => ({
    ...l,
    status: newStatus,
    decided_at: "2026-07-01T09:00:00.000Z",
  }));
}

function readWellbeing(): WellbeingResult {
  return computeWellbeing({
    staffId: STAFF,
    now: NOW,
    assignments: [],
    changes: [],
    leave: leaveRows,
    exceptions: [],
  });
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        staleTime: 10 * 60_000, // mirror the app's long staleTime
      },
    },
  });
}

async function primeAndObserve(qc: QueryClient) {
  // Both wellbeing queries pull the same source through computeWellbeing;
  // that's the actual wire the dashboards use.
  const adminQueryFn = async () => readWellbeing();
  const mineQueryFn = async () => readWellbeing();

  await qc.prefetchQuery({ queryKey: ["admin-wellbeing"], queryFn: adminQueryFn });
  await qc.prefetchQuery({
    queryKey: ["my-wellbeing", STAFF],
    queryFn: mineQueryFn,
  });

  const observers = [
    new QueryObserver(qc, { queryKey: ["admin-wellbeing"], queryFn: adminQueryFn }),
    new QueryObserver(qc, { queryKey: ["my-wellbeing", STAFF], queryFn: mineQueryFn }),
  ];
  const unsubs = observers.map((o) => o.subscribe(() => {}));

  return {
    dispose: () => unsubs.forEach((u) => u()),
    adminData: () =>
      qc.getQueryData<WellbeingResult>(["admin-wellbeing"]),
    mineData: () =>
      qc.getQueryData<WellbeingResult>(["my-wellbeing", STAFF]),
  };
}

async function waitForResult(read: () => WellbeingResult | undefined, predicate: (r: WellbeingResult) => boolean) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const r = read();
    if (r && predicate(r)) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  const final = read();
  throw new Error(
    `wellbeing result never matched predicate; last value: ${JSON.stringify(final)}`,
  );
}

function leaveDriverCount(r: WellbeingResult): number {
  const d = r.drivers.find((x) => x.key === "leave");
  if (!d) throw new Error("leave driver missing");
  return d.value as number;
}

beforeEach(() => {
  seedPending();
});

describe("invalidateWellbeing triggers fresh computeWellbeing after leave status update", () => {
  it("pending → rejected: leave driver goes 0 → 1 and score drops", async () => {
    const qc = makeClient();
    const { adminData, mineData, dispose } = await primeAndObserve(qc);

    const beforeAdmin = adminData()!;
    const beforeMine = mineData()!;
    expect(leaveDriverCount(beforeAdmin)).toBe(0);
    expect(leaveDriverCount(beforeMine)).toBe(0);

    // Simulate the mutation the leave route performs, then invalidate.
    updateLeaveStatus("rejected");
    invalidateWellbeing(qc, "test.leave.rejected");

    const afterAdmin = await waitForResult(adminData, (r) => leaveDriverCount(r) === 1);
    const afterMine = await waitForResult(mineData, (r) => leaveDriverCount(r) === 1);

    expect(afterAdmin.score).toBeLessThan(beforeAdmin.score);
    expect(afterMine.score).toBeLessThan(beforeMine.score);
    expect(afterAdmin.drivers.find((d) => d.key === "leave")!.label).toBe(
      "1 rejected/cancelled leave",
    );

    dispose();
  });

  it("pending → cancelled: leave driver goes 0 → 1 and score drops", async () => {
    const qc = makeClient();
    const { adminData, mineData, dispose } = await primeAndObserve(qc);

    const beforeAdmin = adminData()!;
    const beforeMine = mineData()!;
    expect(leaveDriverCount(beforeAdmin)).toBe(0);
    expect(leaveDriverCount(beforeMine)).toBe(0);

    updateLeaveStatus("cancelled");
    invalidateWellbeing(qc, "test.leave.cancelled");

    const afterAdmin = await waitForResult(adminData, (r) => leaveDriverCount(r) === 1);
    const afterMine = await waitForResult(mineData, (r) => leaveDriverCount(r) === 1);

    expect(afterAdmin.score).toBeLessThan(beforeAdmin.score);
    expect(afterMine.score).toBeLessThan(beforeMine.score);

    dispose();
  });

  it("WITHOUT invalidateWellbeing, the cache keeps the stale computed result (guards the invariant)", async () => {
    // Negative control: proves the previous two tests would fail if the
    // invalidate wire were removed — i.e. we're actually measuring the
    // effect of invalidateWellbeing, not just React Query's freshness.
    const qc = makeClient();
    const { adminData, mineData, dispose } = await primeAndObserve(qc);

    const staleAdmin = adminData()!;
    const staleMine = mineData()!;

    updateLeaveStatus("rejected");
    // …no invalidate call.

    await new Promise((r) => setTimeout(r, 50));

    expect(adminData()).toEqual(staleAdmin);
    expect(mineData()).toEqual(staleMine);
    expect(leaveDriverCount(adminData()!)).toBe(0);
    expect(leaveDriverCount(mineData()!)).toBe(0);

    dispose();
  });
});
