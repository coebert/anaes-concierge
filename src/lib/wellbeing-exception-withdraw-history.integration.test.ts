import "@/test/assert-utc-hook";
/**
 * Pipeline contract: withdrawing an exception report must update the
 * my-wellbeing query result (the "history" it feeds — drivers, score, and
 * window) exactly once, without leaving duplicate driver entries or
 * duplicate cache rows for the same query key.
 *
 * Why this test exists
 * --------------------
 * Two failure modes we want to lock out:
 *
 *   1. A withdraw fires `invalidateWellbeing` but the query result never
 *      recomputes — the exceptions driver stays at its pre-withdraw value
 *      even though the underlying data changed. `waitForResult` on the
 *      new value would time out.
 *
 *   2. A withdraw somehow adds a second `exceptions` driver (e.g. because
 *      a merge accidentally concatenates instead of replacing) or a
 *      second cache row appears under the same key. This is a real risk
 *      for optimistic UI code that patches caches in place. The `driver
 *      keys are unique` assertion and the `cache has exactly one entry
 *      per key` assertion catch both.
 *
 * Complements `wellbeing-invalidate-recompute.integration.test.ts` (which
 * covers leave-status transitions).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import {
  computeWellbeing,
  type ExceptionReportLite,
  type WellbeingResult,
} from "@/features/wellbeing/wellbeing-score";

const STAFF = "staff-1";
const NOW = new Date("2026-07-10T00:00:00.000Z");

// The `withdrawn` flag on this fake DB is what the exception page's PATCH
// would set. The queryFn re-reads it on every fetch, exactly like the
// PostgREST `.neq("status", "withdrawn")` filter on the live route.
type FakeException = {
  id: string;
  staff_id: string;
  event_date: string;
  withdrawn: boolean;
};

let exceptionRows: FakeException[] = [];

function seedThreeOpenExceptions() {
  exceptionRows = [
    { id: "ex-1", staff_id: STAFF, event_date: "2026-06-15", withdrawn: false },
    { id: "ex-2", staff_id: STAFF, event_date: "2026-06-22", withdrawn: false },
    { id: "ex-3", staff_id: STAFF, event_date: "2026-07-01", withdrawn: false },
  ];
}

function withdraw(id: string) {
  exceptionRows = exceptionRows.map((r) =>
    r.id === id ? { ...r, withdrawn: true } : r,
  );
}

function activeExceptions(): ExceptionReportLite[] {
  // Mirrors the "neq withdrawn" filter used by both wellbeing routes.
  return exceptionRows
    .filter((r) => !r.withdrawn)
    .map((r) => ({ staff_id: r.staff_id, event_date: r.event_date }));
}

function readWellbeing(): WellbeingResult {
  return computeWellbeing({
    staffId: STAFF,
    now: NOW,
    assignments: [],
    changes: [],
    leave: [],
    exceptions: activeExceptions(),
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
        staleTime: 10 * 60_000,
      },
    },
  });
}

async function primeAndObserve(qc: QueryClient) {
  const queryFn = async () => readWellbeing();

  await qc.prefetchQuery({ queryKey: ["my-wellbeing", STAFF], queryFn });

  const observer = new QueryObserver(qc, {
    queryKey: ["my-wellbeing", STAFF],
    queryFn,
  });
  const unsub = observer.subscribe(() => {});

  return {
    dispose: () => unsub(),
    read: () => qc.getQueryData<WellbeingResult>(["my-wellbeing", STAFF]),
  };
}

async function waitFor(
  read: () => WellbeingResult | undefined,
  predicate: (r: WellbeingResult) => boolean,
) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const r = read();
    if (r && predicate(r)) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  const final = read();
  throw new Error(
    `wellbeing predicate never satisfied; last value: ${JSON.stringify(final)}`,
  );
}

function exceptionsDriverValue(r: WellbeingResult): number {
  const d = r.drivers.find((x) => x.key === "exceptions");
  if (!d) throw new Error("exceptions driver missing");
  return d.value as number;
}

function driverKeys(r: WellbeingResult): string[] {
  return r.drivers.map((d) => d.key);
}

function cacheEntriesFor(qc: QueryClient, key: readonly unknown[]) {
  // React Query keys the cache by a deterministic hash of the queryKey.
  // Two cache rows under logically the same key would show up as two
  // matching entries here.
  return qc.getQueryCache().findAll({ queryKey: key });
}

beforeEach(() => {
  seedThreeOpenExceptions();
});

describe("withdrawing an exception updates my-wellbeing history without duplicates", () => {
  it("single withdraw: exceptions driver drops by 1 and score improves", async () => {
    const qc = makeClient();
    const { read, dispose } = await primeAndObserve(qc);

    const before = read()!;
    expect(exceptionsDriverValue(before)).toBe(3);
    expect(before.drivers.find((d) => d.key === "exceptions")!.label).toBe(
      "3 trainee exception reports",
    );

    // Same pipeline the ExceptionCard withdraw handler drives:
    // (1) mutate the row's status, then (2) invalidateWellbeing.
    withdraw("ex-2");
    invalidateWellbeing(qc, "exception.withdraw");

    const after = await waitFor(read, (r) => exceptionsDriverValue(r) === 2);

    // Lower harm ⇒ higher score (wellbeing score is 100 − harm).
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.drivers.find((d) => d.key === "exceptions")!.label).toBe(
      "2 trainee exception reports",
    );

    dispose();
  });

  it("driver keys stay unique after a withdraw — no duplicate entries", async () => {
    const qc = makeClient();
    const { read, dispose } = await primeAndObserve(qc);

    const before = read()!;
    const beforeKeys = driverKeys(before);
    expect(new Set(beforeKeys).size).toBe(beforeKeys.length);

    withdraw("ex-1");
    invalidateWellbeing(qc, "exception.withdraw");

    const after = await waitFor(read, (r) => exceptionsDriverValue(r) === 2);
    const afterKeys = driverKeys(after);

    // "No duplicate entries" — the same driver key must not appear twice
    // in the result. A regression that appends an "exceptions" driver
    // instead of replacing it would fail this check.
    expect(new Set(afterKeys).size).toBe(afterKeys.length);
    expect(afterKeys).toEqual(beforeKeys);
    expect(afterKeys.filter((k) => k === "exceptions")).toHaveLength(1);

    dispose();
  });

  it("cache has exactly one entry per key across repeated withdraws", async () => {
    const qc = makeClient();
    const { read, dispose } = await primeAndObserve(qc);

    // Baseline: one cache row for ["my-wellbeing", STAFF].
    expect(cacheEntriesFor(qc, ["my-wellbeing", STAFF])).toHaveLength(1);

    withdraw("ex-1");
    invalidateWellbeing(qc, "exception.withdraw");
    await waitFor(read, (r) => exceptionsDriverValue(r) === 2);
    expect(cacheEntriesFor(qc, ["my-wellbeing", STAFF])).toHaveLength(1);

    withdraw("ex-2");
    invalidateWellbeing(qc, "exception.withdraw");
    await waitFor(read, (r) => exceptionsDriverValue(r) === 1);
    expect(cacheEntriesFor(qc, ["my-wellbeing", STAFF])).toHaveLength(1);

    withdraw("ex-3");
    invalidateWellbeing(qc, "exception.withdraw");
    const final = await waitFor(read, (r) => exceptionsDriverValue(r) === 0);

    // Three withdraws → one cache row, drivers still unique, exceptions
    // driver at zero. This is the "no duplicated history" invariant.
    expect(cacheEntriesFor(qc, ["my-wellbeing", STAFF])).toHaveLength(1);
    expect(new Set(driverKeys(final)).size).toBe(final.drivers.length);
    expect(exceptionsDriverValue(final)).toBe(0);

    dispose();
  });

  it("re-withdrawing an already-withdrawn row is a no-op on the cached result", async () => {
    // Idempotency: clicking Withdraw twice (or a stale UI double-tap) must
    // not shift the exceptions count past zero and must not push a second
    // "history" row into the cache.
    const qc = makeClient();
    const { read, dispose } = await primeAndObserve(qc);

    withdraw("ex-1");
    invalidateWellbeing(qc, "exception.withdraw");
    const first = await waitFor(read, (r) => exceptionsDriverValue(r) === 2);

    // "Withdraw" the same id again — the fake DB already flagged it, so
    // `activeExceptions()` returns the same set.
    withdraw("ex-1");
    invalidateWellbeing(qc, "exception.withdraw");
    await new Promise((r) => setTimeout(r, 30));

    const second = read()!;
    expect(exceptionsDriverValue(second)).toBe(2);
    expect(second.score).toBe(first.score);
    expect(cacheEntriesFor(qc, ["my-wellbeing", STAFF])).toHaveLength(1);
    expect(new Set(driverKeys(second)).size).toBe(second.drivers.length);

    dispose();
  });
});
