import { describe, it, expect } from "vitest";
import { buildWeekStatusTimeline, loadWeekStatus, type WeekStatusRow } from "./rota-week-status";

// Synthetic only.
const row = (
  week_start: string,
  status_code: WeekStatusRow["status_code"],
  observed_at = "2030-01-20T00:00:00Z",
): WeekStatusRow => ({
  week_start,
  status_code,
  source_values: [],
  rows_seen: 3,
  planned_rows: 0,
  actual_rows: 3,
  observed_at,
  status_since: observed_at,
});
const NOW = new Date("2030-01-21T00:00:00Z");

describe("buildWeekStatusTimeline", () => {
  it("covers every week in the window; unobserved weeks are 'not_observed', never a status", () => {
    const t = buildWeekStatusTimeline({
      rangeStart: "2030-01-09", // mid-week → starts at its Monday
      rangeEnd: "2030-01-27",
      rows: [row("2030-01-07", "published"), row("2030-01-21", "not_setup")],
      capture: "available",
      now: NOW,
    });
    expect(t.weeks.map((w) => [w.weekStart, w.status])).toEqual([
      ["2030-01-07", "published"],
      ["2030-01-14", "not_observed"],
      ["2030-01-21", "not_setup"],
    ]);
  });

  it("flags stale observations", () => {
    const t = buildWeekStatusTimeline({
      rangeStart: "2030-01-07",
      rangeEnd: "2030-01-13",
      rows: [row("2030-01-07", "setup", "2030-01-10T00:00:00Z")],
      capture: "available",
      now: NOW,
    });
    expect(t.weeks[0].stale).toBe(true);
  });

  it("not installed → every week not_observed", () => {
    const t = buildWeekStatusTimeline({
      rangeStart: "2030-01-07",
      rangeEnd: "2030-01-13",
      rows: [row("2030-01-07", "published")],
      capture: "not_installed",
      now: NOW,
    });
    expect(t.weeks[0].status).toBe("not_observed");
  });
});

describe("loadWeekStatus", () => {
  type Res = { data: WeekStatusRow[] | null; error: { code?: string; message?: string } | null };
  function client(page: (from: number) => Res) {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "gte", "lte", "order"]) chain[m] = () => chain;
    chain.range = (from: number) => Promise.resolve(page(from));
    return { from: () => chain };
  }
  it("pages and returns rows", async () => {
    const all = Array.from({ length: 1200 }, (_, i) =>
      row(new Date(Date.UTC(2000, 0, 3 + 7 * i)).toISOString().slice(0, 10), "published"),
    );
    const r = await loadWeekStatus(
      "2000-01-03",
      "2030-01-01",
      client((f) => ({ data: all.slice(f, f + 1000), error: null })),
    );
    expect(r.capture).toBe("available");
    expect(r.rows).toHaveLength(1200);
  });
  it("missing table → not_installed", async () => {
    const r = await loadWeekStatus(
      "2030-01-07",
      "2030-01-13",
      client(() => ({ data: null, error: { code: "PGRST205" } })),
    );
    expect(r).toEqual({ rows: [], capture: "not_installed" });
  });
  it("other errors throw (Retry, not a silent unknown)", async () => {
    await expect(
      loadWeekStatus(
        "2030-01-07",
        "2030-01-13",
        client(() => ({ data: null, error: { code: "42501", message: "denied" } })),
      ),
    ).rejects.toThrow();
  });
});
