import { describe, expect, it, vi } from "vitest";

const results: Record<string, { data: unknown; error: { message: string } | null }> = {};
vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "lte", "in", "order", "range"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown) => res(results[table] ?? { data: [], error: null });
    return b;
  };
  return { supabase: { from: (t: string) => builder(t) } };
});

import { computeLeaveConflicts, leaveHalvesOn } from "./leave-utils";

describe("leaveHalvesOn", () => {
  it("PM start covers only the afternoon of the start date", () => {
    expect([...leaveHalvesOn({ start_date: "2026-04-06", end_date: "2026-04-07", half_day_start: "pm" }, "2026-04-06")]).toEqual(["pm"]);
  });
  it("AM end covers only the morning of the end date", () => {
    expect([...leaveHalvesOn({ start_date: "2026-04-06", end_date: "2026-04-07", half_day_end: "am" }, "2026-04-07")]).toEqual(["am"]);
  });
});

describe("computeLeaveConflicts", () => {
  it("throws (never 'no conflicts') when a lookup fails", async () => {
    results.rota_assignments = { data: null, error: { message: "timeout" } };
    await expect(computeLeaveConflicts("me", "2026-04-06", "2026-04-07")).rejects.toThrow(/rota assignments/);
    results.rota_assignments = { data: [], error: null };
    results.leave_requests = { data: null, error: { message: "denied" } };
    await expect(computeLeaveConflicts("me", "2026-04-06", "2026-04-07")).rejects.toThrow(/colleagues/);
  });
  it("my PM-only day does not clash with a colleague's AM-only last day", async () => {
    results.rota_assignments = { data: [], error: null };
    results.leave_requests = {
      data: [{ id: "x", staff_id: "c", start_date: "2026-04-03", end_date: "2026-04-06", half_day_start: null, half_day_end: "am" }],
      error: null,
    };
    results.profiles = { data: [{ id: "c", full_name: "Dr C" }], error: null };
    const c = await computeLeaveConflicts("me", "2026-04-06", "2026-04-07", "pm", null);
    expect(c).toEqual([]);
    const c2 = await computeLeaveConflicts("me", "2026-04-06", "2026-04-07", null, null);
    expect(c2).toEqual([{ date: "2026-04-06", session: "am", type: "other_leave", staffName: "Dr C" }]);
  });
});
