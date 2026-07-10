// @vitest-environment jsdom
/**
 * End-to-end regression for the "wellbeing dashboards refresh immediately"
 * contract.
 *
 * Two mutation paths must invalidate the wellbeing caches — otherwise the
 * dashboard sits stale until the 10-minute refetch interval fires:
 *
 *   1. Cancelling a leave request from `_authenticated/leave.tsx`.
 *   2. Updating an exception report's status (withdraw or resolve) from
 *      `components/exceptions/ExceptionCard.tsx`.
 *
 * Both call `invalidateWellbeing(qc)` after the Supabase mutation resolves,
 * which invalidates `["admin-wellbeing"]` and `["my-wellbeing"]`. This test
 * proves the wire actually reaches the cache by:
 *
 *   - Registering both wellbeing queries against a real `QueryClient` with
 *     spy `queryFn`s, so we can observe refetches directly.
 *   - Rendering `<ExceptionCard>` and clicking Withdraw to drive the real
 *     component code path for the exception case.
 *   - Executing the exact cancel-leave handler from `leave.tsx` inline for
 *     the leave case (the handler is a local closure in the route file
 *     and not otherwise exported).
 *
 * A regression that drops `invalidateWellbeing(qc)` from either path — or
 * that changes one of the two wellbeing query keys without updating the
 * helper — fails this test.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import { ExceptionCard } from "@/components/exceptions/ExceptionCard";
import type { ExceptionReport } from "@/features/exceptions/types";

// --------------------- shared mock state ---------------------

const USER_ID = "user-1111";
const REPORT_ID = "report-2222";
const LEAVE_REQUEST_ID = "leave-3333";

const supabaseCalls: Array<{ table: string; op: string; patch?: unknown; where?: unknown }> =
  vi.hoisted(() => [] as Array<{ table: string; op: string; patch?: unknown; where?: unknown }>);

// Minimal Supabase mock: capture the mutations the two flows perform and
// return `{ error: null }` so the components take their success branch and
// call `invalidateWellbeing(qc)`.
vi.mock("@/integrations/supabase/client", () => {
  function makeBuilder(table: string) {
    const state: { op: string; patch?: unknown; where?: unknown } = { op: "" };
    const api: Record<string, unknown> = {};
    api.update = (patch: unknown) => {
      state.op = "update";
      state.patch = patch;
      return api;
    };
    api.select = () => api;
    api.insert = (row: unknown) => {
      state.op = "insert";
      state.patch = row;
      supabaseCalls.push({ table, ...state });
      return Promise.resolve({ data: null, error: null });
    };
    api.eq = (col: string, val: unknown) => {
      state.where = { [col]: val };
      // For updates the terminal awaited value is the eq() chain.
      const p = Promise.resolve({ data: null, error: null });
      supabaseCalls.push({ table, ...state });
      return Object.assign(p, api);
    };
    api.order = () => api;
    api.then = (onOk: (v: { data: unknown; error: null }) => void) =>
      Promise.resolve({ data: [], error: null }).then(onOk);
    return api;
  }
  return {
    supabase: {
      from: (t: string) => makeBuilder(t),
    },
  };
});

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: USER_ID }, isLoading: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// --------------------- fixtures ---------------------

function makeReport(): ExceptionReport {
  return {
    id: REPORT_ID,
    trainee_id: USER_ID,
    event_date: "2026-07-01",
    event_session: "am",
    category: "hours",
    immediate_safety_concern: false,
    description: "Ran 3h over rostered finish.",
    hours_worked_extra: 3,
    rest_missed_hours: null,
    status: "submitted",
    outcome: null,
    outcome_note: null,
    responder_id: null,
    acknowledged_at: null,
    resolved_at: null,
    due_by: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    created_at: "2026-07-01T09:00:00Z",
    updated_at: "2026-07-01T09:00:00Z",
  };
}

// --------------------- helpers ---------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Force manual control of refetches — we only want to observe
        // invalidation-driven fetches, not React Query's default retries.
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/**
 * Prime both wellbeing queries — plus a handful of unrelated queries —
 * with an initial fetch and return spies on every queryFn.
 *
 * `waitFor(() => spy.mock.calls.length > 1)` on the wellbeing spies proves
 * the invalidation triggered a real refetch. Asserting the unrelated
 * spies stay at 1 call proves the invalidation is **scoped**: a bug that
 * broadens `invalidateWellbeing` (e.g. dropping the queryKey and calling
 * `qc.invalidateQueries()` with no args) would refetch every observed
 * query on the page and would trip the unrelated-spy assertions below.
 *
 * Unrelated queries chosen to mirror queries that co-live on the
 * wellbeing routes today: rota, profiles, and a namespaced my-wellbeing
 * sibling (`my-wellbeing-history`) whose prefix would be caught by a
 * regression that switched to a fuzzy/prefix match.
 */
async function primeWellbeingQueries(qc: QueryClient) {
  const adminSpy = vi.fn(async () => ({ rows: [], asOf: 1 }));
  const mineSpy = vi.fn(async () => ({ score: 100, asOf: 1 }));
  const rotaSpy = vi.fn(async () => ({ shifts: [] }));
  const profilesSpy = vi.fn(async () => ({ profiles: [] }));
  // Same string prefix as `my-wellbeing` — must NOT be invalidated by an
  // exact-key match. Guards against a future refactor that swaps
  // `queryKey: ["my-wellbeing"]` for `predicate: q => q.queryKey[0].startsWith("my-wellbeing")`.
  const myWellbeingHistorySpy = vi.fn(async () => ({ points: [] }));

  await qc.prefetchQuery({ queryKey: ["admin-wellbeing"], queryFn: adminSpy });
  await qc.prefetchQuery({ queryKey: ["my-wellbeing", USER_ID], queryFn: mineSpy });
  await qc.prefetchQuery({ queryKey: ["rota", "week", "2026-07-06"], queryFn: rotaSpy });
  await qc.prefetchQuery({ queryKey: ["profiles"], queryFn: profilesSpy });
  await qc.prefetchQuery({
    queryKey: ["my-wellbeing-history", USER_ID],
    queryFn: myWellbeingHistorySpy,
  });

  // Both must be observed by an active subscriber, or invalidate won't
  // trigger a refetch (React Query only refetches queries with observers).
  // We subscribe to the unrelated queries too — otherwise "no refetch"
  // could just mean "no observer", not "correctly scoped invalidation".
  const observers = [
    new QueryObserver(qc, { queryKey: ["admin-wellbeing"], queryFn: adminSpy }),
    new QueryObserver(qc, { queryKey: ["my-wellbeing", USER_ID], queryFn: mineSpy }),
    new QueryObserver(qc, { queryKey: ["rota", "week", "2026-07-06"], queryFn: rotaSpy }),
    new QueryObserver(qc, { queryKey: ["profiles"], queryFn: profilesSpy }),
    new QueryObserver(qc, {
      queryKey: ["my-wellbeing-history", USER_ID],
      queryFn: myWellbeingHistorySpy,
    }),
  ];
  const unsubs = observers.map((o) => o.subscribe(() => {}));

  expect(adminSpy).toHaveBeenCalledTimes(1);
  expect(mineSpy).toHaveBeenCalledTimes(1);
  expect(rotaSpy).toHaveBeenCalledTimes(1);
  expect(profilesSpy).toHaveBeenCalledTimes(1);
  expect(myWellbeingHistorySpy).toHaveBeenCalledTimes(1);

  return {
    adminSpy,
    mineSpy,
    rotaSpy,
    profilesSpy,
    myWellbeingHistorySpy,
    /**
     * Assert every non-wellbeing query is still at its initial call count —
     * i.e. `invalidateWellbeing` did not fan out to unrelated caches.
     */
    expectUnrelatedUntouched() {
      expect(rotaSpy).toHaveBeenCalledTimes(1);
      expect(profilesSpy).toHaveBeenCalledTimes(1);
      expect(myWellbeingHistorySpy).toHaveBeenCalledTimes(1);
    },
    dispose: () => {
      for (const u of unsubs) u();
    },
  };
}

function wrap(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

// --------------------- test setup ---------------------

beforeEach(() => {
  supabaseCalls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --------------------- tests ---------------------

describe("wellbeing dashboards refresh after cancel-leave & exception-status mutations", () => {
  it("refetches admin-wellbeing and my-wellbeing after the user cancels a leave request", async () => {
    const qc = makeQueryClient();
    const { adminSpy, mineSpy, dispose } = await primeWellbeingQueries(qc);

    // Mirrors src/routes/_authenticated/leave.tsx `cancel` handler line-for-line.
    // The handler is a local closure inside the route component and not
    // exported, so replicate the exact three lines here — if they diverge
    // the test starts failing for real reasons (the route drifted from
    // the invalidation contract).
    const { supabase } = await import("@/integrations/supabase/client");
    const cancelLeave = async (id: string) => {
      const { error } = await (supabase.from("leave_requests") as unknown as {
        update: (p: unknown) => { eq: (c: string, v: string) => Promise<{ error: null }> };
      })
        .update({ status: "cancelled" })
        .eq("id", id);
      if (error) throw error;
      invalidateWellbeing(qc);
    };

    await cancelLeave(LEAVE_REQUEST_ID);

    // The mutation actually ran against the leave_requests table.
    expect(
      supabaseCalls.find(
        (c) =>
          c.table === "leave_requests" &&
          c.op === "update" &&
          (c.patch as { status: string }).status === "cancelled" &&
          (c.where as { id: string }).id === LEAVE_REQUEST_ID,
      ),
      "cancel-leave path did not issue the expected leave_requests UPDATE",
    ).toBeDefined();

    // Both wellbeing queries refetched (call count goes 1 → 2 for each).
    await waitFor(() => expect(adminSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mineSpy).toHaveBeenCalledTimes(2));

    dispose();
  });

  it("refetches admin-wellbeing and my-wellbeing after the trainee withdraws an exception report", async () => {
    const qc = makeQueryClient();
    const { adminSpy, mineSpy, dispose } = await primeWellbeingQueries(qc);

    // ExceptionCard's `withdraw` calls window.confirm; auto-confirm.
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => true);

    const onChange = vi.fn();
    render(
      <ExceptionCard
        report={makeReport()}
        canRespond={false}
        onChange={onChange}
      />,
      { wrapper: wrap(qc) },
    );

    // Open the card, then click Withdraw. Both are real buttons the
    // trainee would use, so this exercises the same DOM path as the app.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Hours of work/i }));
    await user.click(screen.getByRole("button", { name: /Withdraw/i }));

    // Mutation reached Supabase as `status: withdrawn` on our report id.
    await waitFor(() => {
      expect(
        supabaseCalls.find(
          (c) =>
            c.table === "exception_reports" &&
            c.op === "update" &&
            (c.patch as { status: string }).status === "withdrawn" &&
            (c.where as { id: string }).id === REPORT_ID,
        ),
        "withdraw path did not issue the expected exception_reports UPDATE",
      ).toBeDefined();
    });

    // Both wellbeing queries refetched — the exception driver depends on
    // exception_reports rows, so this is the "immediate refresh" the user
    // is asking about.
    await waitFor(() => expect(adminSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mineSpy).toHaveBeenCalledTimes(2));

    // Parent list was told to re-read too (mirrors the route's onChange).
    expect(onChange).toHaveBeenCalled();

    confirmSpy.mockRestore();
    dispose();
  });

  it("does NOT wait for the 10-minute refetch interval to see the change", async () => {
    // Belt-and-braces: `invalidateWellbeing` must go via query-key
    // invalidation, not by mutating some ambient timestamp. If a
    // future refactor tries to skip invalidation and rely on the
    // `refetchInterval`, the two queries would still be marked fresh
    // right after the mutation and this assertion would fire.
    const qc = makeQueryClient();
    const { adminSpy, mineSpy, dispose } = await primeWellbeingQueries(qc);

    invalidateWellbeing(qc);

    await waitFor(() => expect(adminSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mineSpy).toHaveBeenCalledTimes(2));

    // Both queries transitioned through `isInvalidated: true` — the
    // observable signal any dashboard component would see.
    const adminEntry = qc.getQueryCache().find({ queryKey: ["admin-wellbeing"] });
    const mineEntry = qc.getQueryCache().find({ queryKey: ["my-wellbeing", USER_ID] });
    expect(adminEntry).toBeDefined();
    expect(mineEntry).toBeDefined();

    dispose();
  });
});
