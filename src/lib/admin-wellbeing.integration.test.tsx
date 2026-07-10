// @vitest-environment jsdom
/**
 * Integration regression for the admin wellbeing page.
 *
 * The page fans out into six paginated Supabase reads and rolls the result
 * into a per-staff wellbeing + attrition rubric. A silent regression to a
 * single unordered `.range()` on `leave_requests` would drop recent study
 * and compassionate spells past the db-max-rows cap, making the wellbeing
 * score look artificially healthy for staff with recent problematic leave.
 *
 * This test renders `AdminWellbeingPage` end-to-end with a fake Supabase
 * client that:
 *   1. Records every `.order()` and `.range()` call so we can assert the
 *      leave read is paginated AND ordered by end_date desc.
 *   2. Enforces the same 1,000-row db-max-rows cap the hosted Data API
 *      applies, so a broken (non-paginated) read would silently drop the
 *      recent study/compassionate rows we inject past that boundary.
 *
 * The wellbeing score is then read straight from the rendered DOM — proving
 * the study + compassionate leave signals travel all the way through the
 * page's data pipeline into the visible score/band, not just the standalone
 * `computeWellbeing` unit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminWellbeingPage } from "@/routes/_authenticated/admin.wellbeing";

const DB_MAX_ROWS = 1000;
const TODAY = new Date();
const DAY_MS = 86_400_000;
const isoDaysAgo = (d: number) =>
  new Date(TODAY.getTime() - d * DAY_MS).toISOString().slice(0, 10);

type Row = Record<string, unknown>;

/**
 * Table-scoped call log. One entry per Supabase `.from(table)` chain, so
 * assertions like "leave_requests was ordered by end_date desc and read via
 * multiple paged .range() calls" are trivial.
 */
type TableCallLog = {
  table: string;
  orderCalls: Array<{ key: string; ascending: boolean }>;
  rangeCalls: Array<{ from: number; to: number }>;
  eqFilters: Array<{ key: string; value: unknown }>;
  gteFilters: Array<{ key: string; value: unknown }>;
};

const callLogs: TableCallLog[] = [];
const rowsByTable: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const log: TableCallLog = {
    table,
    orderCalls: [],
    rangeCalls: [],
    eqFilters: [],
    gteFilters: [],
  };
  callLogs.push(log);
  let orderKey: string | null = null;
  let ascending = true;
  const eqFilters: Array<{ key: string; value: unknown }> = [];
  const gteFilters: Array<{ key: string; value: unknown }> = [];

  const api: Record<string, unknown> = {
    select: () => api,
    eq(key: string, value: unknown) {
      log.eqFilters.push({ key, value });
      eqFilters.push({ key, value });
      return api;
    },
    gte(key: string, value: unknown) {
      log.gteFilters.push({ key, value });
      gteFilters.push({ key, value });
      return api;
    },
    order(key: string, opts: { ascending: boolean }) {
      log.orderCalls.push({ key, ascending: opts.ascending });
      orderKey = key;
      ascending = opts.ascending;
      return api;
    },
    async range(from: number, to: number) {
      log.rangeCalls.push({ from, to });
      let source = (rowsByTable[table] ?? []).slice();
      for (const f of eqFilters) source = source.filter((r) => r[f.key] === f.value);
      for (const g of gteFilters) source = source.filter((r) => (r[g.key] as string) >= (g.value as string));
      if (orderKey) {
        const k = orderKey;
        const dir = ascending ? 1 : -1;
        source.sort((a, b) => {
          const av = a[k];
          const bv = b[k];
          if (av === bv) return 0;
          return ((av as string | number) < (bv as string | number) ? -1 : 1) * dir;
        });
      }
      // Enforce the db-max-rows cap: no single response can exceed 1,000
      // rows. A broken (unpaginated) caller would only ever see the first
      // 1,000 rows of the underlying set — exactly the historical bug.
      const cappedTo = Math.min(to, from + DB_MAX_ROWS - 1);
      return { data: source.slice(from, cappedTo + 1), error: null };
    },
  };
  return api;
}

const fakeSupabase = {
  from: (table: string) => makeBuilder(table),
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: fakeSupabase,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    loading: false,
    hasRole: () => true,
    isCoordinatorOrAdmin: () => true,
    user: { id: "admin-user" },
    session: {},
    roles: ["admin"],
    grade: null,
    fullName: "Test Admin",
    isAuthenticated: true,
    isTrainee: () => false,
    signOut: async () => {},
    refreshRoles: async () => {},
  }),
}));

// createFileRoute is a build-time router registration and doesn't need to
// do anything meaningful in a component render test.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (_config: unknown) => ({ options: _config }),
  Navigate: ({ to }: { to: string }) => <span data-testid="navigate" data-to={to} />,
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AdminWellbeingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callLogs.length = 0;
  for (const k of Object.keys(rowsByTable)) delete rowsByTable[k];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminWellbeingPage — study & compassionate leave integration", () => {
  it("uses paginated, end_date-ordered reads for leave_requests and surfaces recent study/compassionate denials in the rendered score", async () => {
    // Two staff so the page can rank them worst-first:
    //   - Dr Study — has a denied study spell 15 days ago (in the 90-day window)
    //   - Dr Compassionate — has a cancelled compassionate spell 20 days ago
    // Padding rows push the table past the 1,000-row db-max-rows cap so a
    // single unordered .range() would silently drop the recent denials.
    rowsByTable.profiles = [
      { id: "s-study", full_name: "Dr Study", email: null, grade: "consultant", active: true },
      { id: "s-compassionate", full_name: "Dr Compassionate", email: null, grade: "consultant", active: true },
    ];

    const leave: Row[] = [
      {
        id: "l-study-denied",
        staff_id: "s-study",
        type: "study",
        status: "denied",
        start_date: isoDaysAgo(16),
        end_date: isoDaysAgo(15),
        half_day_start: null,
        half_day_end: null,
        created_at: isoDaysAgo(30),
        decided_at: isoDaysAgo(28),
      },
      {
        id: "l-comp-cancelled",
        staff_id: "s-compassionate",
        type: "compassionate",
        status: "cancelled",
        start_date: isoDaysAgo(21),
        end_date: isoDaysAgo(20),
        half_day_start: null,
        half_day_end: null,
        created_at: isoDaysAgo(40),
        decided_at: isoDaysAgo(38),
      },
    ];
    // 1,200 padding rows — old, harmless, but enough to force the paginated
    // read across the db-max-rows boundary.
    for (let i = 0; i < 1_200; i++) {
      leave.push({
        id: `pad-${i}`,
        staff_id: i % 2 === 0 ? "s-study" : "s-compassionate",
        type: "annual",
        status: "approved",
        start_date: isoDaysAgo(400 + i),
        end_date: isoDaysAgo(400 + i),
        half_day_start: null,
        half_day_end: null,
        created_at: isoDaysAgo(500 + i),
        decided_at: isoDaysAgo(498 + i),
      });
    }
    rowsByTable.leave_requests = leave;
    rowsByTable.rota_assignments = [];
    rowsByTable.rota_change_log = [];
    rowsByTable.exception_reports = [];
    rowsByTable.return_to_work_interviews = [];

    renderPage();

    // Wait for both staff rows to render.
    await waitFor(
      () => {
        expect(screen.getByText("Dr Study")).toBeTruthy();
        expect(screen.getByText("Dr Compassionate")).toBeTruthy();
      },
      { timeout: 3000 },
    );

    // --- Assertion 1: leave_requests was read via .order('end_date', desc). ---
    const leaveLogs = callLogs.filter((l) => l.table === "leave_requests");
    expect(leaveLogs.length).toBeGreaterThan(0);
    const leaveOrders = leaveLogs.flatMap((l) => l.orderCalls);
    expect(
      leaveOrders.some((o) => o.key === "end_date" && o.ascending === false),
      "leave_requests must be ordered by end_date DESC so the paginated fetch surfaces the newest study/compassionate spells first",
    ).toBe(true);

    // --- Assertion 2: leave_requests was PAGINATED, not read in one wide range. ---
    // 1,202 rows / 1,000 per page → at least 2 pages, and the pager also
    // issues a short/empty stop page. Multiple `.range()` calls prove the
    // pager didn't collapse into a single unordered read.
    const leaveRanges = leaveLogs.flatMap((l) => l.rangeCalls);
    expect(leaveRanges.length).toBeGreaterThanOrEqual(2);
    // Each individual range must be at most one page wide — a wide
    // `.range(0, 19999)` would be a regression to the historical bug.
    for (const r of leaveRanges) {
      expect(r.to - r.from + 1).toBeLessThanOrEqual(1000);
    }

    // --- Assertion 3: both denials reach the rendered score. ---
    // The page renders the score in the same TableRow as the staff name.
    // A denied study/compassionate spell inside the 90-day window bumps the
    // `leave` driver, so score < 100.
    const studyRow = screen.getByText("Dr Study").closest("tr")!;
    const compRow = screen.getByText("Dr Compassionate").closest("tr")!;
    expect(studyRow).toBeTruthy();
    expect(compRow).toBeTruthy();

    // The score cell has the `tabular-nums` class in this template, but
    // safer to just extract every integer from the row's text.
    const parseScore = (row: HTMLElement): number => {
      const cells = within(row).getAllByRole("cell");
      // Score column is index 2 (Staff, Grade, Score, …).
      const raw = cells[2]?.textContent?.trim() ?? "";
      const n = Number.parseInt(raw, 10);
      expect(Number.isFinite(n), `expected an integer score, got "${raw}"`).toBe(true);
      return n;
    };
    const studyScore = parseScore(studyRow);
    const compScore = parseScore(compRow);

    // Both denials must have degraded the score below the perfect 100.
    expect(studyScore).toBeLessThan(100);
    expect(compScore).toBeLessThan(100);
  });

  it("all six wellbeing tables are read with a deterministic .order(...) — no unordered wide reads", async () => {
    rowsByTable.profiles = [
      { id: "s-1", full_name: "Solo Staff", email: null, grade: "consultant", active: true },
    ];
    rowsByTable.leave_requests = [];
    rowsByTable.rota_assignments = [];
    rowsByTable.rota_change_log = [];
    rowsByTable.exception_reports = [];
    rowsByTable.return_to_work_interviews = [];

    renderPage();
    await waitFor(() => expect(screen.getByText("Solo Staff")).toBeTruthy(), {
      timeout: 3000,
    });

    // Every paged Supabase read on this page must apply a `.order(...)` so
    // the db-max-rows cap can't silently drop rows in an undefined order.
    const pagedTables = [
      "profiles",
      "rota_assignments",
      "rota_change_log",
      "leave_requests",
      "exception_reports",
      "return_to_work_interviews",
    ] as const;
    for (const table of pagedTables) {
      const logs = callLogs.filter((l) => l.table === table);
      expect(logs.length, `expected at least one call to ${table}`).toBeGreaterThan(0);
      const anyOrder = logs.flatMap((l) => l.orderCalls);
      expect(
        anyOrder.length,
        `expected ${table} to be read with an .order(...) clause`,
      ).toBeGreaterThan(0);
    }
  });
});
