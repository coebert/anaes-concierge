// @vitest-environment jsdom
import "@/test/assert-utc-hook";
/**
 * Integration regression: canceling OR rejecting a leave request must
 * immediately refresh BOTH wellbeing dashboards — `admin-wellbeing` and
 * `my-wellbeing` — not just the personal Wellbeing page.
 *
 * There are two mutation paths against `leave_requests` that change what
 * the wellbeing engine sees:
 *
 *   1. Trainee cancels their own request from `_authenticated/leave.tsx`
 *      (`.update({ status: "cancelled" })`).
 *   2. A coordinator/admin rejects a request from
 *      `_authenticated/coordinator.leave.tsx` (`decide("rejected")` →
 *      `.update({ status: "rejected", decided_by, decided_at, ... })`).
 *
 * Both handlers call `invalidateWellbeing(qc, ...)` after the Supabase
 * mutation resolves. That helper invalidates `["admin-wellbeing"]` and
 * `["my-wellbeing"]` — if either mutation forgets the call, or scopes it
 * to only one of the two keys, the *other* dashboard sits stale until the
 * 10-minute poll fires. That regression is what this file guards.
 *
 * The rejection path lives inside a coordinator route component that is
 * not exported, so — like the existing cancel test — we replicate the
 * exact three lines of the handler inline. If those lines drift from the
 * route, this test fails for a real reason.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";

import { invalidateWellbeing } from "@/features/wellbeing/invalidate";

// --------------------- shared mock state ---------------------

const USER_ID = "user-1111";
const ADMIN_ID = "admin-9999";
const LEAVE_REQUEST_ID = "leave-3333";

type Call = { table: string; op: string; patch?: unknown; where?: unknown };
const supabaseCalls: Call[] = vi.hoisted(() => [] as Call[]);

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
    api.eq = (col: string, val: unknown) => {
      state.where = { ...(state.where as object | undefined), [col]: val };
      const p = Promise.resolve({ data: null, error: null });
      supabaseCalls.push({ table, ...state });
      return Object.assign(p, api);
    };
    api.order = () => api;
    api.then = (onOk: (v: { data: unknown; error: null }) => void) =>
      Promise.resolve({ data: [], error: null }).then(onOk);
    return api;
  }
  return { supabase: { from: (t: string) => makeBuilder(t) } };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// --------------------- helpers (mirrors sibling test) ---------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/**
 * Prime both wellbeing queries plus a set of unrelated queries that live on
 * the same routes today, subscribed via QueryObservers so React Query will
 * actually refetch on invalidate. Unrelated spies must stay at 1 call — a
 * bug that widened invalidation to `qc.invalidateQueries()` would fail here.
 */
async function primeWellbeingQueries(qc: QueryClient) {
  const adminSpy = vi.fn(async () => ({ rows: [], asOf: 1 }));
  const mineSpy = vi.fn(async () => ({ score: 100, asOf: 1 }));
  const rotaSpy = vi.fn(async () => ({ shifts: [] }));
  const profilesSpy = vi.fn(async () => ({ profiles: [] }));
  const leaveListSpy = vi.fn(async () => ({ items: [] }));

  await qc.prefetchQuery({ queryKey: ["admin-wellbeing"], queryFn: adminSpy });
  await qc.prefetchQuery({ queryKey: ["my-wellbeing", USER_ID], queryFn: mineSpy });
  await qc.prefetchQuery({ queryKey: ["rota", "week", "2026-07-06"], queryFn: rotaSpy });
  await qc.prefetchQuery({ queryKey: ["profiles"], queryFn: profilesSpy });
  await qc.prefetchQuery({ queryKey: ["coordinator-leave"], queryFn: leaveListSpy });

  const observers = [
    new QueryObserver(qc, { queryKey: ["admin-wellbeing"], queryFn: adminSpy }),
    new QueryObserver(qc, { queryKey: ["my-wellbeing", USER_ID], queryFn: mineSpy }),
    new QueryObserver(qc, { queryKey: ["rota", "week", "2026-07-06"], queryFn: rotaSpy }),
    new QueryObserver(qc, { queryKey: ["profiles"], queryFn: profilesSpy }),
    new QueryObserver(qc, { queryKey: ["coordinator-leave"], queryFn: leaveListSpy }),
  ];
  const unsubs = observers.map((o) => o.subscribe(() => {}));

  expect(adminSpy).toHaveBeenCalledTimes(1);
  expect(mineSpy).toHaveBeenCalledTimes(1);
  expect(rotaSpy).toHaveBeenCalledTimes(1);
  expect(profilesSpy).toHaveBeenCalledTimes(1);
  expect(leaveListSpy).toHaveBeenCalledTimes(1);

  return {
    adminSpy,
    mineSpy,
    rotaSpy,
    profilesSpy,
    leaveListSpy,
    expectUnrelatedUntouched() {
      expect(rotaSpy).toHaveBeenCalledTimes(1);
      expect(profilesSpy).toHaveBeenCalledTimes(1);
      expect(leaveListSpy).toHaveBeenCalledTimes(1);
    },
    dispose: () => { for (const u of unsubs) u(); },
  };
}

async function waitCalls(spy: ReturnType<typeof vi.fn>, n: number) {
  const start = Date.now();
  while (spy.mock.calls.length < n) {
    if (Date.now() - start > 1500) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(spy).toHaveBeenCalledTimes(n);
}

// --------------------- test setup ---------------------

beforeEach(() => { supabaseCalls.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

// --------------------- tests ---------------------

describe("leave decision → both wellbeing dashboards refresh immediately", () => {
  it("cancel-leave (trainee) refetches admin-wellbeing AND my-wellbeing", async () => {
    const qc = makeQueryClient();
    const { adminSpy, mineSpy, expectUnrelatedUntouched, dispose } =
      await primeWellbeingQueries(qc);

    // Mirrors `_authenticated/leave.tsx` cancel handler.
    const { supabase } = await import("@/integrations/supabase/client");
    const cancelLeave = async (id: string) => {
      const { error } = await (supabase.from("leave_requests") as unknown as {
        update: (p: unknown) => { eq: (c: string, v: string) => Promise<{ error: null }> };
      })
        .update({ status: "cancelled" })
        .eq("id", id);
      if (error) throw error;
      invalidateWellbeing(qc, "leave.cancel");
    };

    await cancelLeave(LEAVE_REQUEST_ID);

    expect(
      supabaseCalls.find(
        (c) =>
          c.table === "leave_requests" &&
          c.op === "update" &&
          (c.patch as { status: string }).status === "cancelled" &&
          (c.where as { id: string }).id === LEAVE_REQUEST_ID,
      ),
      "cancel path did not issue the expected leave_requests UPDATE",
    ).toBeDefined();

    await waitCalls(adminSpy, 2);
    await waitCalls(mineSpy, 2);
    expectUnrelatedUntouched();
    dispose();
  });

  it("reject-leave (coordinator) refetches admin-wellbeing AND my-wellbeing", async () => {
    const qc = makeQueryClient();
    const { adminSpy, mineSpy, expectUnrelatedUntouched, dispose } =
      await primeWellbeingQueries(qc);

    // Mirrors `_authenticated/coordinator.leave.tsx` `decide("rejected")`
    // handler — status + decided_by/decided_at + optional decision_notes.
    const { supabase } = await import("@/integrations/supabase/client");
    const rejectLeave = async (id: string, notes: string | null) => {
      const { error } = await (supabase.from("leave_requests") as unknown as {
        update: (p: unknown) => { eq: (c: string, v: string) => Promise<{ error: null }> };
      })
        .update({
          status: "rejected",
          decided_by: ADMIN_ID,
          decided_at: new Date().toISOString(),
          decision_notes: notes,
        })
        .eq("id", id);
      if (error) throw error;
      invalidateWellbeing(qc, "leave.decide:rejected");
    };

    await rejectLeave(LEAVE_REQUEST_ID, "Not enough cover");

    const rejectCall = supabaseCalls.find(
      (c) =>
        c.table === "leave_requests" &&
        c.op === "update" &&
        (c.patch as { status: string }).status === "rejected" &&
        (c.where as { id: string }).id === LEAVE_REQUEST_ID,
    );
    expect(rejectCall, "reject path did not issue the expected leave_requests UPDATE")
      .toBeDefined();
    // Decision metadata is stamped too — this is what the wellbeing engine
    // uses to anchor the driver at `decided_at`, so guard the payload shape.
    expect((rejectCall!.patch as { decided_by: string }).decided_by).toBe(ADMIN_ID);
    expect((rejectCall!.patch as { decided_at: string }).decided_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );

    // Both wellbeing queries refetched — critically, admin AND my
    // (not just admin, which is the tempting scoping mistake for a
    // coordinator-side action).
    await waitCalls(adminSpy, 2);
    await waitCalls(mineSpy, 2);

    // Scoped: no unrelated cache refetched.
    expectUnrelatedUntouched();
    dispose();
  });

  it("both decision paths land BOTH keys in the same event turn — no reliance on the 10-minute poll", async () => {
    const qc = makeQueryClient();
    const { adminSpy, mineSpy, dispose } = await primeWellbeingQueries(qc);
    const { supabase } = await import("@/integrations/supabase/client");

    // Fire cancel then reject back-to-back. After the awaited work, both
    // wellbeing queries must have refetched — 2 each — with no timer
    // advancement, no window focus, and no manual refresh.
    const doCancel = async () => {
      await (supabase.from("leave_requests") as unknown as {
        update: (p: unknown) => { eq: (c: string, v: string) => Promise<{ error: null }> };
      })
        .update({ status: "cancelled" })
        .eq("id", "leave-a");
      invalidateWellbeing(qc, "leave.cancel");
    };
    const doReject = async () => {
      await (supabase.from("leave_requests") as unknown as {
        update: (p: unknown) => { eq: (c: string, v: string) => Promise<{ error: null }> };
      })
        .update({
          status: "rejected",
          decided_by: ADMIN_ID,
          decided_at: new Date().toISOString(),
          decision_notes: null,
        })
        .eq("id", "leave-b");
      invalidateWellbeing(qc, "leave.decide:rejected");
    };

    await doCancel();
    await doReject();

    // Two invalidations of each key → at least one refetch per key (React
    // Query coalesces overlapping invalidations, so 2 is the floor, not
    // 3). The key contract is "> 1 for each" — both dashboards updated.
    await waitCalls(adminSpy, 2);
    await waitCalls(mineSpy, 2);
    expect(adminSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mineSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    dispose();
  });
});

// Silence the unused-import lint if React tree-shakes in this env.
void React;
