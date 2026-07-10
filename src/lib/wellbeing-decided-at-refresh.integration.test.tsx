// @vitest-environment jsdom
import "@/test/assert-utc-hook";
/**
 * End-to-end regression: cancelling or rejecting a leave request updates
 * the rendered wellbeing page immediately, and the new score reflects the
 * `decided_at` anchor — NOT the leave's `start_date`.
 *
 * `computeWellbeing` counts rejected/cancelled leave whose "when" falls
 * inside the 90-day window. The anchor is:
 *   - `decided_at` (sliced to yyyy-mm-dd) when present, else
 *   - `start_date` as fallback.
 * Unit coverage for the anchor lives in
 * `src/lib/wellbeing-score-decided-at-anchor.test.ts`. This test proves
 * the wire from a cancel/reject mutation → invalidation → refetch →
 * render actually uses that anchor when the page updates:
 *
 *   Baseline: one leave row with `start_date` INSIDE window, no `decided_at`.
 *             It counts against the leave driver (fallback path).
 *   After cancel/reject: `status` flips to cancelled/rejected and the DB
 *             sets `decided_at`. We deliberately move `start_date` FAR OUT
 *             of the window and place `decided_at` inside — if the page
 *             recomputes off `start_date`, the count would drop to 0. It
 *             must stay at 1 because the anchor is now `decided_at`.
 *
 * The leave-driver label (`"${N} rejected/cancelled leave"`) is the
 * surfaced signal; asserting on it locks the visible refresh contract.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { invalidateWellbeing } from "@/features/wellbeing/invalidate";

// --------------------- shared mock state ---------------------

const USER_ID = "user-decided-at";
// Fixed "now" so the 90-day window is deterministic. Window opens at
// NOW - 90d = 2026-04-11 (inclusive by day-string).
const NOW = new Date("2026-07-10T12:00:00Z");
const IN_WINDOW_DAY = "2026-05-01"; // inside 90-day window
const IN_WINDOW_TS = "2026-05-01T09:00:00Z";
const OUT_WINDOW_DAY = "2020-01-01"; // far outside the window
const IN_WINDOW_LATE_TS = "2026-05-01T23:59:59Z"; // must still anchor on 2026-05-01

type LeaveRow = {
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  decided_at: string | null;
  half_day_start: string | null;
  half_day_end: string | null;
};

// Controllable data source. Each test flips `leaveRows` between the
// "before cancel/reject" and "after cancel/reject" snapshots and drives a
// query invalidation to trigger the refetch — mirroring what
// `invalidateWellbeing(qc, ...)` does after the real mutation resolves.
const state = vi.hoisted(() => ({
  leaveRows: [] as Array<{
    staff_id: string;
    type: string;
    status: string;
    start_date: string;
    end_date: string;
    decided_at: string | null;
    half_day_start: string | null;
    half_day_end: string | null;
  }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  function makeBuilder(table: string) {
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = () => api;
    api.neq = () => api;
    api.gte = () => api;
    api.lte = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.or = () => api;
    api.in = () => api;
    api.maybeSingle = () => Promise.resolve({ data: null, error: null });
    api.single = api.maybeSingle;
    api.range = () => {
      // Only leave_requests carries fixture data; every other table
      // paginates as empty so the wellbeing driver we care about is the
      // ONLY one that can move between snapshots.
      const data =
        table === "leave_requests" ? (state.leaveRows as unknown[]) : [];
      return Promise.resolve({ data, error: null });
    };
    (api as Record<string, unknown>).then = (
      ok: (v: { data: unknown[]; error: null }) => unknown,
      err: (e: unknown) => unknown,
    ) => Promise.resolve({ data: [], error: null }).then(ok, err);
    return api;
  }
  return {
    supabase: {
      from: (t: string) => makeBuilder(t),
      // get_recognition_decrypted rpc — return empty.
      rpc: () => Promise.resolve({ data: [], error: null }),
    },
  };
});

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    loading: false,
    hasRole: () => true,
    isCoordinatorOrAdmin: () => false,
    user: { id: USER_ID },
    session: {},
    roles: [],
    grade: null,
    fullName: "Test User",
    isAuthenticated: true,
    isTrainee: () => false,
    signOut: async () => {},
    refreshRoles: async () => {},
  }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (_config: unknown) => ({ options: _config }),
    Navigate: ({ to }: { to: string }) => <span data-testid="navigate" data-to={to} />,
    Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("@/components/wellbeing/PulseSurveyDialog", () => ({
  PulseSurveyDialog: () => null,
}));
vi.mock("@/components/wellbeing/RecognitionDialog", () => ({
  RecognitionDialog: () => null,
}));

const { WellbeingPage } = await import("@/routes/_authenticated/wellbeing");

// --------------------- helpers ---------------------

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <WellbeingPage />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

async function waitForInitialLoad(qc: QueryClient) {
  await waitFor(() => expect(qc.isFetching()).toBe(0), { timeout: 3000 });
}

/**
 * Prime a set of unrelated queries against the same QueryClient with spy
 * queryFns, subscribed via QueryObservers (React Query only refetches
 * queries with active observers). If a future regression widens
 * `invalidateWellbeing` — e.g. drops the queryKey filter and calls
 * `qc.invalidateQueries()` — every one of these spies would fire again,
 * failing `expectUnrelatedUntouched()`.
 *
 * The keys were chosen to represent the caches that actually co-live on
 * the wellbeing routes today: rota, profiles, coordinator-leave lists,
 * plus a `my-wellbeing-history` sibling that shares the string prefix
 * with `my-wellbeing` — a regression that swapped exact-key match for a
 * prefix match would trip that spy.
 */
async function primeUnrelated(qc: QueryClient) {
  const spies = {
    rota: vi.fn(async () => ({ shifts: [] })),
    profiles: vi.fn(async () => ({ profiles: [] })),
    coordinatorLeave: vi.fn(async () => ({ items: [] })),
    myWellbeingHistory: vi.fn(async () => ({ points: [] })),
  };
  const opts = [
    { queryKey: ["rota", "week", "2026-07-06"], queryFn: spies.rota },
    { queryKey: ["profiles"], queryFn: spies.profiles },
    { queryKey: ["coordinator-leave"], queryFn: spies.coordinatorLeave },
    { queryKey: ["my-wellbeing-history", USER_ID], queryFn: spies.myWellbeingHistory },
  ] as const;
  for (const o of opts) await qc.prefetchQuery(o);
  const unsubs = opts.map((o) =>
    new QueryObserver(qc, { queryKey: o.queryKey, queryFn: o.queryFn }).subscribe(
      () => {},
    ),
  );
  for (const s of Object.values(spies)) expect(s).toHaveBeenCalledTimes(1);
  return {
    expectUnrelatedUntouched() {
      // Each unrelated cache stays at 1 fetch — invalidation was scoped
      // to the wellbeing keys only.
      expect(spies.rota).toHaveBeenCalledTimes(1);
      expect(spies.profiles).toHaveBeenCalledTimes(1);
      expect(spies.coordinatorLeave).toHaveBeenCalledTimes(1);
      expect(spies.myWellbeingHistory).toHaveBeenCalledTimes(1);
    },
    dispose: () => { for (const u of unsubs) u(); },
  };
}

function leaveDriverLabel(): string {
  // The wellbeing-score engine emits the leave driver as:
  //   `${badLeave} rejected/cancelled leave`
  // The page renders every driver as a row; find that specific label.
  const nodes = Array.from(document.body.querySelectorAll("*")).filter((el) =>
    /^\d+ rejected\/cancelled leave$/.test(el.textContent?.trim() ?? ""),
  );
  if (nodes.length === 0) throw new Error("leave driver label not found");
  return nodes[0].textContent!.trim();
}

function pendingRow(overrides: Partial<LeaveRow> = {}): LeaveRow {
  return {
    staff_id: USER_ID,
    type: "annual",
    status: "pending",
    start_date: IN_WINDOW_DAY,
    end_date: IN_WINDOW_DAY,
    decided_at: null,
    half_day_start: null,
    half_day_end: null,
    ...overrides,
  };
}

beforeEach(() => {
  // shouldAdvanceTime keeps microtask/setInterval progression alive so
  // testing-library's `waitFor` (which polls on setInterval) still ticks
  // while we pin `Date.now()` to NOW for the wellbeing window.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.leaveRows = [];
  vi.clearAllMocks();
});

// --------------------- tests ---------------------

describe(
  "wellbeing page reflects decided_at-based score immediately after cancel/reject",
  () => {
    it(
      "cancelling a leave request: after invalidation the leave driver counts the row " +
        "by its decided_at (in-window) even when start_date has been shifted out of window",
      async () => {
        // Baseline: a pending leave inside the window. It does NOT count
        // (only rejected/cancelled feed the leave driver), so the driver
        // starts at 0.
        state.leaveRows = [pendingRow()];

        const { qc } = renderPage();
        await waitForInitialLoad(qc);
        expect(leaveDriverLabel()).toBe("0 rejected/cancelled leave");

        // Simulate the cancel handler in `_authenticated/leave.tsx`:
        //   1) DB row flips to status=cancelled and gets a decided_at.
        //   2) The route calls `invalidateWellbeing(qc, "leave.cancel")`.
        // The critical assertion is that the anchor used to include this
        // row in the count is the NEW decided_at, not start_date — we
        // move start_date OUT of the window so a start_date-based recount
        // would go to 0, but the decided_at-based count must be 1.
        state.leaveRows = [
          pendingRow({
            status: "cancelled",
            start_date: OUT_WINDOW_DAY,
            end_date: OUT_WINDOW_DAY,
            decided_at: IN_WINDOW_TS,
          }),
        ];

        await act(async () => {
          await qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
        });

        await waitFor(() => {
          expect(leaveDriverLabel()).toBe("1 rejected/cancelled leave");
        });
      },
    );

    it(
      "rejecting a leave request: after invalidation the driver counts it via decided_at, " +
        "and a late-UTC decided_at still slices to its calendar day",
      async () => {
        state.leaveRows = [pendingRow()];
        const { qc } = renderPage();
        await waitForInitialLoad(qc);
        expect(leaveDriverLabel()).toBe("0 rejected/cancelled leave");

        // Reject flow: status → rejected, DB stamps decided_at at end of
        // the calendar day. If a regression compared the full ISO string
        // to the window bounds (instead of slicing to yyyy-mm-dd), the
        // late-UTC timestamp could miscompare.
        state.leaveRows = [
          pendingRow({
            status: "rejected",
            start_date: OUT_WINDOW_DAY,
            end_date: OUT_WINDOW_DAY,
            decided_at: IN_WINDOW_LATE_TS,
          }),
        ];
        await act(async () => {
          await qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
        });
        await waitFor(() => {
          expect(leaveDriverLabel()).toBe("1 rejected/cancelled leave");
        });
      },
    );

    it(
      "a cancelled row whose decided_at is outside the window (start_date inside) does " +
        "NOT count — proves the page reads the decided_at anchor, not start_date",
      async () => {
        // Straight to the "after mutation" state: the row is cancelled,
        // start_date is IN window (would count under a naive start-date
        // filter), but decided_at is OUT of window. The engine must
        // prefer decided_at → count = 0.
        state.leaveRows = [
          pendingRow({
            status: "cancelled",
            start_date: IN_WINDOW_DAY,
            end_date: IN_WINDOW_DAY,
            decided_at: "2020-01-01T09:00:00Z",
          }),
        ];
        const { qc } = renderPage();
        await waitForInitialLoad(qc);
        expect(leaveDriverLabel()).toBe("0 rejected/cancelled leave");
      },
    );
  },
);
