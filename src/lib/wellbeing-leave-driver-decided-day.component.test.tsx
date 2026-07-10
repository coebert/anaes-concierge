// @vitest-environment jsdom
import "@/test/assert-utc-hook";
/**
 * Component test: `/wellbeing` renders the leave-driver label using the
 * DAY portion of `decided_at` (`decided_at.slice(0, 10)`) consistently,
 * regardless of the time-of-day component of the timestamp.
 *
 * This locks in the day-normalisation contract at the UI level:
 *
 *   - Multiple rejected/cancelled rows whose `decided_at` differs only
 *     in time-of-day (00:15Z, 12:00Z, 23:45Z) on the SAME calendar day
 *     all count once each — the driver label reads `3 rejected/cancelled
 *     leave`, not something dependent on hh:mm:ss.
 *   - Re-mounting the page with the SAME rows in a different order
 *     (or with the timestamps rewritten to different hh:mm:ss values on
 *     the same day) produces byte-identical driver-label text.
 *   - A row whose `decided_at` day sits on the inclusive window-start
 *     boundary is counted regardless of hh:mm:ss on that day; a row on
 *     the day BEFORE the window is not counted, even at 23:59:59Z.
 *
 * A regression that compared `decided_at` as a full timestamp against
 * the window boundary (instead of `.slice(0, 10)`) would flip the
 * boundary row's inclusion based on time-of-day and desynchronise the
 * label from the reference `computeWellbeing(...)` count.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, cleanup, waitFor } from "@testing-library/react";

import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

const USER_ID = "user-decided-day";
// Pin "now" so the 90-day window is deterministic. Window covers
// [NOW-90d, NOW] inclusive, day-normalised.
// Anchor at UTC midnight so the 90-day window boundary is a clean
// calendar-day boundary (`isoDay(now - 90d)` == `windowStart`).
const NOW = new Date("2026-07-10T00:00:00Z");
// 90 days before 2026-07-10 = 2026-04-11 (inclusive window start).
const BOUNDARY_DAY = "2026-04-11";
const BEFORE_BOUNDARY_DAY = "2026-04-10";
const MID_WINDOW_DAY = "2026-05-20";

type LeaveRow = {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  decided_at: string | null;
  half_day_start: string | null;
  half_day_end: string | null;
  created_at: string;
};

const state = vi.hoisted(() => ({
  leaveRows: [] as LeaveRow[],
}));

vi.mock("@/integrations/supabase/client", () => {
  function tableRows(table: string): unknown[] {
    if (table === "leave_requests") return state.leaveRows;
    return [];
  }
  function makeBuilder(table: string) {
    const eqFilters: Array<[string, unknown]> = [];
    let orderKey: string | null = null;
    let ascending = true;
    let limitN: number | null = null;
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (k: string, v: unknown) => {
      eqFilters.push([k, v]);
      return api;
    };
    api.neq = () => api;
    api.gte = () => api;
    api.lte = () => api;
    api.order = (k: string, opts: { ascending: boolean }) => {
      orderKey = k;
      ascending = opts.ascending;
      return api;
    };
    api.limit = (n: number) => {
      limitN = n;
      return api;
    };
    api.range = async (from: number, to: number) => {
      let rows = tableRows(table).slice() as Array<Record<string, unknown>>;
      for (const [k, v] of eqFilters) rows = rows.filter((r) => r[k] === v);
      if (orderKey) {
        const k = orderKey;
        const dir = ascending ? 1 : -1;
        rows.sort((a, b) => {
          const av = a[k];
          const bv = b[k];
          if (av === bv) return 0;
          return ((av as string | number) < (bv as string | number) ? -1 : 1) * dir;
        });
      }
      const cappedTo = Math.min(to, from + 1000 - 1);
      return { data: rows.slice(from, cappedTo + 1), error: null };
    };
    (api as { then: unknown }).then = (
      ok: (v: { data: unknown[]; error: null }) => unknown,
      err?: (e: unknown) => unknown,
    ) => {
      let rows = tableRows(table).slice() as Array<Record<string, unknown>>;
      for (const [k, v] of eqFilters) rows = rows.filter((r) => r[k] === v);
      if (limitN != null) rows = rows.slice(0, limitN);
      return Promise.resolve({ data: rows, error: null }).then(ok, err);
    };
    return api;
  }
  return {
    supabase: {
      from: (t: string) => makeBuilder(t),
      rpc: () => Promise.resolve({ data: [], error: null }),
    },
  };
});

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    loading: false,
    hasRole: () => false,
    isCoordinatorOrAdmin: () => false,
    user: { id: USER_ID },
    session: {},
    roles: [],
    grade: null,
    fullName: "Decided Day Doctor",
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

function makeRow(id: string, overrides: Partial<LeaveRow>): LeaveRow {
  return {
    id,
    staff_id: USER_ID,
    type: "annual",
    status: "rejected",
    start_date: MID_WINDOW_DAY,
    end_date: MID_WINDOW_DAY,
    decided_at: `${MID_WINDOW_DAY}T12:00:00Z`,
    half_day_start: null,
    half_day_end: null,
    created_at: `${MID_WINDOW_DAY}T12:00:00Z`,
    ...overrides,
  };
}

function toLeaveLite(rows: LeaveRow[]): LeaveLite[] {
  return rows.map((r) => ({
    staff_id: r.staff_id,
    status: r.status,
    type: r.type,
    start_date: r.start_date,
    end_date: r.end_date,
    decided_at: r.decided_at,
  }));
}

function renderWithClient(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>{node}</QueryClientProvider>,
  );
  return { qc, ...utils };
}

async function waitForFetchesToSettle(qc: QueryClient) {
  await waitFor(() => expect(qc.isFetching()).toBe(0), { timeout: 3000 });
}

function driverLabelText(): string {
  const node = Array.from(document.body.querySelectorAll("*")).find((el) =>
    /^\d+ rejected\/cancelled leave$/.test(el.textContent?.trim() ?? ""),
  );
  expect(node, "leave-driver label not found").toBeTruthy();
  return node!.textContent!.trim();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.leaveRows = [];
  vi.clearAllMocks();
});

describe("wellbeing page — leave-driver label uses normalised decided_at day", () => {
  it("counts rejected/cancelled rows by DAY, ignoring hh:mm:ss on decided_at", async () => {
    // 3 rows on the same mid-window calendar day, times spread across
    // the whole UTC day. Under day-normalisation all three count.
    state.leaveRows = [
      makeRow("l-early", {
        status: "rejected",
        decided_at: `${MID_WINDOW_DAY}T00:15:00Z`,
      }),
      makeRow("l-noon", {
        status: "cancelled",
        decided_at: `${MID_WINDOW_DAY}T12:00:00Z`,
      }),
      makeRow("l-late", {
        status: "rejected",
        decided_at: `${MID_WINDOW_DAY}T23:45:00Z`,
      }),
    ];

    const reference = computeWellbeing({
      staffId: USER_ID,
      now: NOW,
      assignments: [],
      changes: [],
      leave: toLeaveLite(state.leaveRows),
      exceptions: [],
    });
    expect(reference.drivers.find((d) => d.key === "leave")!.label).toBe(
      "3 rejected/cancelled leave",
    );

    const { qc } = renderWithClient(<WellbeingPage />);
    await waitForFetchesToSettle(qc);
    await waitFor(() =>
      expect(driverLabelText()).toBe("3 rejected/cancelled leave"),
    );
  });

  it(
    "produces byte-identical driver-label text when the same rows are re-mounted " +
      "in a different order and with different times-of-day on the same day",
    async () => {
      state.leaveRows = [
        makeRow("a", {
          status: "rejected",
          decided_at: `${MID_WINDOW_DAY}T01:00:00Z`,
        }),
        makeRow("b", {
          status: "cancelled",
          decided_at: `${MID_WINDOW_DAY}T14:30:00Z`,
        }),
      ];
      const first = renderWithClient(<WellbeingPage />);
      await waitForFetchesToSettle(first.qc);
      await waitFor(() =>
        expect(driverLabelText()).toBe("2 rejected/cancelled leave"),
      );
      const firstLabel = driverLabelText();
      cleanup();

      // Reorder rows and rewrite hh:mm:ss on the SAME calendar day. If
      // the label consumed the timestamp beyond the day prefix, this
      // second mount would drift.
      state.leaveRows = [
        makeRow("b", {
          status: "cancelled",
          decided_at: `${MID_WINDOW_DAY}T23:59:59Z`,
        }),
        makeRow("a", {
          status: "rejected",
          decided_at: `${MID_WINDOW_DAY}T00:00:01Z`,
        }),
      ];
      const second = renderWithClient(<WellbeingPage />);
      await waitForFetchesToSettle(second.qc);
      await waitFor(() =>
        expect(driverLabelText()).toBe("2 rejected/cancelled leave"),
      );
      expect(driverLabelText()).toBe(firstLabel);
    },
  );

  it(
    "day-normalises the inclusive 90-day boundary — a boundary-day row " +
      "counts at any hh:mm:ss, a day-before-boundary row never does",
    async () => {
      // On-boundary: any time-of-day must be included.
      state.leaveRows = [
        makeRow("boundary-midnight", {
          status: "rejected",
          decided_at: `${BOUNDARY_DAY}T00:00:00Z`,
        }),
        makeRow("boundary-late", {
          status: "cancelled",
          decided_at: `${BOUNDARY_DAY}T23:30:00Z`,
        }),
        // Before-boundary: even at 23:59:59Z the day is out of window.
        makeRow("before-boundary", {
          status: "rejected",
          decided_at: `${BEFORE_BOUNDARY_DAY}T23:59:59Z`,
        }),
      ];

      const reference = computeWellbeing({
        staffId: USER_ID,
        now: NOW,
        assignments: [],
        changes: [],
        leave: toLeaveLite(state.leaveRows),
        exceptions: [],
      });
      // Reference contract: exactly the two boundary-day rows count.
      expect(reference.drivers.find((d) => d.key === "leave")!.value).toBe(2);

      const { qc } = renderWithClient(<WellbeingPage />);
      await waitForFetchesToSettle(qc);
      await waitFor(() =>
        expect(driverLabelText()).toBe("2 rejected/cancelled leave"),
      );
    },
  );
});
