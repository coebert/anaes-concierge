// @vitest-environment jsdom
import "@/test/assert-utc-hook";
/**
 * Cross-route enum-mapping integration test.
 *
 * The wellbeing score's "leave" driver counts leave rows whose
 * `leave_requests.status` (a Postgres enum: pending | approved | rejected
 * | cancelled) is `rejected` OR `cancelled`. TWO routes render this score
 * from the SAME source of truth:
 *
 *   - `/wellbeing` (personal, `WellbeingPage`) filters by the current user.
 *   - `/admin/wellbeing` (`AdminWellbeingPage`) fans out per staff.
 *
 * A regression that changes one route's enum handling (e.g. counts
 * `approved` too, or drops `cancelled`) would silently disagree with the
 * other route while still looking plausible on its own. This test drives
 * both routes against a shared fake DB with rows covering all four enum
 * values plus legacy/unknown status strings, and asserts:
 *
 *   1. The rendered score on `/wellbeing` matches the reference
 *      `computeWellbeing(...)` output for the exact same row set.
 *   2. The rendered score on `/admin/wellbeing` (row for the same staff)
 *      matches that same reference score exactly.
 *   3. Both routes report `<badLeave> rejected/cancelled leave` /
 *      the same underlying tally — legacy strings like `"denied"` don't
 *      leak into either count.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";

import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

// -------------------- shared state --------------------

const USER_ID = "user-enum-consistency";
// Pin "now" so the 90-day window and in-window fixture dates are
// deterministic across runners.
const NOW = new Date("2026-07-10T12:00:00Z");
const IN_WINDOW_DAY = "2026-05-01"; // 70 days before NOW → inside 90d window
const OUT_WINDOW_DAY = "2020-01-01"; // far outside window

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
  leaveRows: [] as Array<{
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
  }>,
  profileRows: [] as Array<{
    id: string;
    full_name: string | null;
    email: string | null;
    grade: string | null;
    active: boolean | null;
  }>,
}));

// -------------------- supabase mock --------------------
//
// Deliberately built once so BOTH routes hit the same fixture. The
// per-builder eq/order state honours the queries each route actually
// issues (personal page filters by staff_id; admin page does not).

vi.mock("@/integrations/supabase/client", () => {
  function tableRows(table: string): unknown[] {
    if (table === "leave_requests") return state.leaveRows;
    if (table === "profiles") return state.profileRows;
    return [];
  }

  function makeBuilder(table: string) {
    const eqFilters: Array<[string, unknown]> = [];
    let orderKey: string | null = null;
    let ascending = true;
    let limitN: number | null = null;

    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (key: string, value: unknown) => {
      eqFilters.push([key, value]);
      return api;
    };
    api.neq = () => api;
    api.gte = () => api;
    api.lte = () => api;
    api.order = (key: string, opts: { ascending: boolean }) => {
      orderKey = key;
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
    // Terminal-await path used by pulse_survey_cycles/responses
    // (`.select().eq().order().limit(1)` -> awaited directly).
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
      // `get_recognition_decrypted` → empty; personal page consumes .data.
      rpc: () => Promise.resolve({ data: [], error: null }),
    },
  };
});

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    loading: false,
    hasRole: () => true, // admin page renders (not redirected)
    isCoordinatorOrAdmin: () => true,
    user: { id: USER_ID },
    session: {},
    roles: ["admin"],
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
const { AdminWellbeingPage } = await import(
  "@/routes/_authenticated/admin.wellbeing"
);

// -------------------- helpers --------------------

function makeRow(id: string, overrides: Partial<LeaveRow>): LeaveRow {
  return {
    id,
    staff_id: USER_ID,
    type: "annual",
    status: "pending",
    start_date: IN_WINDOW_DAY,
    end_date: IN_WINDOW_DAY,
    decided_at: null,
    half_day_start: null,
    half_day_end: null,
    created_at: `${IN_WINDOW_DAY}T09:00:00Z`,
    ...overrides,
  };
}

/**
 * Fixture: one leave row for every DB enum value in-window, plus a
 * handful of legacy/unknown status strings the app might see on old data
 * or from a mis-migrated environment. Only `rejected` and `cancelled`
 * must contribute to the leave driver.
 */
function buildFixtureRows(): LeaveRow[] {
  return [
    makeRow("l-pending", { status: "pending" }),
    makeRow("l-approved", { status: "approved" }),
    makeRow("l-rejected", { status: "rejected", decided_at: `${IN_WINDOW_DAY}T09:00:00Z` }),
    makeRow("l-cancelled", { status: "cancelled", decided_at: `${IN_WINDOW_DAY}T09:00:00Z` }),
    // Legacy / unknown values must NOT count. `denied` was the pre-enum
    // spelling; the others are defensive coverage for schema drift.
    makeRow("l-denied", { status: "denied" }),
    makeRow("l-refused", { status: "refused" }),
    makeRow("l-empty", { status: "" }),
    // Rejected/cancelled OUT of window must not count either — proves
    // the `decided_at` anchor gates entry.
    makeRow("l-rejected-out", {
      status: "rejected",
      start_date: OUT_WINDOW_DAY,
      end_date: OUT_WINDOW_DAY,
      decided_at: `${OUT_WINDOW_DAY}T09:00:00Z`,
    }),
  ];
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

function extractIntFromNode(el: Element): number {
  const raw = el.textContent?.trim() ?? "";
  // The personal page renders "<score>/ 100" in the score card. Grab the
  // leading integer.
  const match = raw.match(/^(\d+)/);
  expect(match, `expected leading integer in "${raw}"`).not.toBeNull();
  return Number.parseInt(match![1]!, 10);
}

function personalScoreFromDom(): number {
  // The score card renders <div class="text-5xl ...">{score}<span>/ 100</span></div>.
  const nodes = Array.from(
    document.body.querySelectorAll("div"),
  ).filter((el) => /^\d+\s*\/\s*100$/.test(el.textContent?.trim() ?? ""));
  expect(nodes.length, "personal score node not found").toBeGreaterThan(0);
  return extractIntFromNode(nodes[0]!);
}

function personalDriverLabel(): string {
  const nodes = Array.from(document.body.querySelectorAll("*")).filter((el) =>
    /^\d+ rejected\/cancelled leave$/.test(el.textContent?.trim() ?? ""),
  );
  expect(nodes.length, "leave driver label not found").toBeGreaterThan(0);
  return nodes[0]!.textContent!.trim();
}

function adminScoreForStaffFromDom(name: string): number {
  const row = screen.getByText(name).closest("tr")!;
  expect(row).toBeTruthy();
  const cells = within(row as HTMLElement).getAllByRole("cell");
  // Columns: Staff, Grade, Score, Wellbeing, Attrition, Top drivers.
  const raw = cells[2]?.textContent?.trim() ?? "";
  const n = Number.parseInt(raw, 10);
  expect(Number.isFinite(n), `expected integer score, got "${raw}"`).toBe(true);
  return n;
}

// -------------------- tests --------------------

beforeEach(() => {
  // Fake timers so `Date.now()` inside the routes' `isoDaysAgo` and
  // inside `computeWellbeing` all resolve against the pinned NOW. Keep
  // microtask/timer progression so `waitFor` still ticks.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);

  state.leaveRows = buildFixtureRows();
  state.profileRows = [
    {
      id: USER_ID,
      full_name: "Enum Test Doctor",
      email: null,
      grade: "consultant",
      active: true,
    },
  ];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.leaveRows = [];
  state.profileRows = [];
  vi.clearAllMocks();
});

describe("wellbeing enum mapping — /wellbeing and /admin/wellbeing agree", () => {
  it("computes the same score on both routes and only counts rejected + cancelled in-window", async () => {
    // Reference score, computed directly from the exact same rows the
    // routes are about to consume via the fake DB. `computeWellbeing`'s
    // partition of the status enum is the single source of truth; if a
    // route disagrees with THIS number, that route regressed.
    const reference = computeWellbeing({
      staffId: USER_ID,
      now: NOW,
      assignments: [],
      changes: [],
      leave: toLeaveLite(state.leaveRows),
      exceptions: [],
    });
    const leaveDriver = reference.drivers.find((d) => d.key === "leave")!;
    // Sanity-anchor the fixture: exactly 2 rows must be "bad leave"
    // (1 rejected in-window + 1 cancelled in-window). All others —
    // pending, approved, legacy strings, and the out-of-window rejected
    // row — are excluded.
    expect(leaveDriver.value).toBe(2);
    expect(leaveDriver.label).toBe("2 rejected/cancelled leave");

    // ---- personal page ----
    const personal = renderWithClient(<WellbeingPage />);
    await waitForFetchesToSettle(personal.qc);
    await waitFor(
      () => expect(personalScoreFromDom()).toBe(reference.score),
      { timeout: 3000 },
    );
    expect(personalDriverLabel()).toBe("2 rejected/cancelled leave");
    cleanup();

    // ---- admin page ----
    const admin = renderWithClient(<AdminWellbeingPage />);
    await waitForFetchesToSettle(admin.qc);
    await waitFor(
      () => expect(screen.getByText("Enum Test Doctor")).toBeTruthy(),
      { timeout: 3000 },
    );
    const adminScore = adminScoreForStaffFromDom("Enum Test Doctor");
    expect(adminScore).toBe(reference.score);
  });

  it(
    "legacy 'denied' rows never leak into the leave driver on either route " +
      "(a regression to the pre-enum spelling would bump the count)",
    async () => {
      // Replace fixture with rows that use the LEGACY spelling only.
      // If either route pattern-matched on "denied", the driver would go
      // to N; the enum contract says it must stay at 0.
      state.leaveRows = [
        makeRow("l-legacy-1", { status: "denied" }),
        makeRow("l-legacy-2", { status: "denied" }),
        makeRow("l-legacy-3", { status: "denied" }),
      ];

      const reference = computeWellbeing({
        staffId: USER_ID,
        now: NOW,
        assignments: [],
        changes: [],
        leave: toLeaveLite(state.leaveRows),
        exceptions: [],
      });
      const leaveDriver = reference.drivers.find((d) => d.key === "leave")!;
      expect(leaveDriver.value).toBe(0);
      // With no other harm signals, the reference score is a perfect 100.
      expect(reference.score).toBe(100);

      const personal = renderWithClient(<WellbeingPage />);
      await waitForFetchesToSettle(personal.qc);
      await waitFor(
        () => expect(personalScoreFromDom()).toBe(100),
        { timeout: 3000 },
      );
      expect(personalDriverLabel()).toBe("0 rejected/cancelled leave");
      cleanup();

      const admin = renderWithClient(<AdminWellbeingPage />);
      await waitForFetchesToSettle(admin.qc);
      await waitFor(
        () => expect(screen.getByText("Enum Test Doctor")).toBeTruthy(),
        { timeout: 3000 },
      );
      expect(adminScoreForStaffFromDom("Enum Test Doctor")).toBe(100);
    },
  );
});
