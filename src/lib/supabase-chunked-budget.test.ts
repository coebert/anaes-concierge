import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAllPaged,
  createQueryBudget,
  reportQueryBudget,
} from "./supabase-chunked";

/**
 * The wellbeing pages fan out into 4-6 paginated reads at once. To catch
 * future regressions where somebody reintroduces a per-staff / per-row
 * fetch, `fetchAllPaged` accepts an optional `budget` that tracks the number
 * of `.range()` requests, and `reportQueryBudget` logs the totals and
 * enforces a hard cap.
 */

type Row = { id: string };

function makeTable(total: number) {
  return {
    range: async (from: number, to: number) => ({
      data: Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => ({
        id: `r-${from + i}`,
      })) as Row[],
      error: null,
    }),
  };
}

describe("query budget instrumentation", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts every .range() request against the budget, keyed by source", async () => {
    const budget = createQueryBudget("wellbeing-leave", 20);
    const table = makeTable(2500);
    await fetchAllPaged<Row>(() => table, { budget, source: "leave_requests" });
    // 2500 rows / 1000 per page → 3 pages (last page short, loop exits).
    expect(budget.count).toBe(3);
    expect(budget.bySource).toEqual({ leave_requests: 3 });
  });

  it("aggregates across multiple sources in the same budget", async () => {
    const budget = createQueryBudget("admin-wellbeing", 20);
    await Promise.all([
      fetchAllPaged<Row>(() => makeTable(1500), { budget, source: "leave_requests" }),
      fetchAllPaged<Row>(() => makeTable(500), { budget, source: "profiles" }),
      fetchAllPaged<Row>(() => makeTable(3200), { budget, source: "rota_assignments" }),
    ]);
    expect(budget.bySource).toEqual({
      leave_requests: 2,
      profiles: 1,
      rota_assignments: 4,
    });
    expect(budget.count).toBe(7);
  });

  it("reportQueryBudget is a no-op under budget in test mode", async () => {
    const budget = createQueryBudget("wellbeing-leave", 10);
    await fetchAllPaged<Row>(() => makeTable(1000), { budget, source: "leave_requests" });
    expect(() => reportQueryBudget(budget)).not.toThrow();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reportQueryBudget does NOT throw over budget in test mode (tests inspect count directly)", async () => {
    const budget = createQueryBudget("wellbeing-leave", 1);
    budget.count = 50;
    budget.bySource = { leave_requests: 50 };
    // In test mode the guard is intentionally silent so unit tests can
    // simulate over-budget scenarios without crashing the runner.
    expect(() => reportQueryBudget(budget)).not.toThrow();
  });

  it("supports the legacy pageSize-as-number signature (no budget)", async () => {
    const rows = await fetchAllPaged<Row>(() => makeTable(50), 25);
    expect(rows.length).toBe(50);
  });

  it("regression: a wellbeing-leave page fanout stays within the 60-request budget", async () => {
    // Simulates what admin.wellbeing.tsx does today: 6 paged reads in parallel.
    // Even at 5000 rows per source (5 pages), total = 30 pages, well under 60.
    const budget = createQueryBudget("admin-wellbeing", 60);
    const sources = [
      "profiles",
      "rota_assignments",
      "rota_change_log",
      "leave_requests",
      "exception_reports",
      "return_to_work_interviews",
    ] as const;
    await Promise.all(
      sources.map((source) =>
        fetchAllPaged<Row>(() => makeTable(5000), { budget, source }),
      ),
    );
    // 5000 rows = 5 full pages of 1000 + one short/empty page that exits the loop.
    expect(budget.count).toBe(36);
    expect(budget.count).toBeLessThanOrEqual(budget.max);
  });
});
