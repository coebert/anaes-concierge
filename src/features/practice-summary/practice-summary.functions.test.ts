/**
 * Server loader: identity comes only from the verified caller; reads are
 * paged and scoped; failures surface instead of empty results. Synthetic.
 */
import { describe, expect, it } from "vitest";
import { loadPracticeSummary } from "./practice-summary.functions";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

type Call = { table: string; ops: Array<[string, unknown[]]> };
function mockDb(
  opts: {
    rulesError?: boolean;
    rows?: Record<string, unknown>[];
    leave?: Record<string, unknown>[];
    leaveError?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const data = (table: string): unknown => {
    if (table === "rota_rules")
      return opts.rulesError
        ? null
        : { sessions_per_pa: 1, oncall_pa_credit: 1.5, weekend_pa_credit: 3 };
    if (table === "profiles") return { full_name: "Synthetic Me", grade: "consultant" };
    if (table === "rota_assignments") return opts.rows ?? [];
    if (table === "leave_requests") return opts.leave ?? [];
    if (table === "theatre_sessions")
      return [
        {
          id: "L1",
          specialties: { name: "Synthetic Gynae" },
          theatres: { name: "Synthetic Theatre 1" },
        },
      ];
    return [];
  };
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "lte", "or", "in", "order", "limit"])
        b[m] = (...a: unknown[]) => (call.ops.push([m, a]), b);
      b.maybeSingle = async () =>
        table === "rota_rules" && opts.rulesError
          ? { data: null, error: { message: "denied" } }
          : { data: data(table), error: null };
      b.range = async (a: number) =>
        table === "leave_requests" && opts.leaveError
          ? { data: null, error: { message: "denied" } }
          : { data: a === 0 ? data(table) : [], error: null };
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return { db, calls };
}

describe("loadPracticeSummary", () => {
  it("scopes the rota read to the caller and returns no other doctor's id", async () => {
    const { db, calls } = mockDb({
      rows: [
        {
          id: "a",
          staff_id: ME,
          session_date: "2030-05-06",
          session: "am",
          duty_type: "theatre",
          extra_type: null,
          pa_credit: null,
          attending_consultant_ids: null,
          theatre_session_id: "L1",
          source: "clwrota",
          locally_modified: false,
          clwrota_external_id: "k1",
        },
        // Over-broad row (as if a policy returned it): must be ignored.
        {
          id: "b",
          staff_id: OTHER,
          session_date: "2030-05-06",
          session: "pm",
          duty_type: "theatre",
          extra_type: null,
          pa_credit: null,
          attending_consultant_ids: null,
          theatre_session_id: null,
          source: "clwrota",
          locally_modified: false,
          clwrota_external_id: "k2",
        },
      ],
    });
    const r = await loadPracticeSummary(
      db as never,
      ME,
      "2030-04-01",
      "2031-03-31",
      new Date("2030-10-01T00:00:00Z"),
    );
    const ra = calls.find((c) => c.table === "rota_assignments")!;
    expect(ra.ops).toContainEqual([
      "or",
      [`staff_id.eq.${ME},attending_consultant_ids.cs.{${ME}}`],
    ]);
    expect(ra.ops).toContainEqual(["order", ["id", { ascending: true }]]);
    expect(r.summary.scope.rosteredEntries).toBe(1);
    expect(r.summary.areas.map((a) => a.area)).toEqual(["Synthetic Gynae"]);
    expect(JSON.stringify(r)).not.toContain(OTHER);
    expect(r.clinician).toEqual({ name: "Synthetic Me", grade: "consultant" });
  });

  it("rejects invalid ranges and a malformed caller id", async () => {
    const { db } = mockDb();
    await expect(loadPracticeSummary(db as never, ME, "2031-01-01", "2030-01-01")).rejects.toThrow(
      /on or before/,
    );
    await expect(
      loadPracticeSummary(db as never, "not-a-uuid", "2030-04-01", "2031-03-31"),
    ).rejects.toThrow("Forbidden");
  });

  it("fails with a clear error (not zeros) when PA settings can't be read", async () => {
    const { db } = mockDb({ rulesError: true });
    await expect(loadPracticeSummary(db as never, ME, "2030-04-01", "2031-03-31")).rejects.toThrow(
      /PA settings/,
    );
  });

  it("reads only the caller's own leave, without reasons, and counts approved working days", async () => {
    const { db, calls } = mockDb({
      leave: [
        {
          id: "l1",
          type: "annual",
          status: "approved",
          start_date: "2030-06-03",
          end_date: "2030-06-07",
          half_day_start: null,
          half_day_end: null,
          clwrota_external_id: "c1",
        },
        {
          id: "l2",
          type: "study",
          status: "pending",
          start_date: "2030-07-01",
          end_date: "2030-07-02",
          half_day_start: null,
          half_day_end: null,
          clwrota_external_id: null,
        },
      ],
    });
    const r = await loadPracticeSummary(
      db as never,
      ME,
      "2030-04-01",
      "2031-03-31",
      new Date("2030-10-01T00:00:00Z"),
    );
    const lr = calls.find((c) => c.table === "leave_requests")!;
    expect(lr.ops).toContainEqual(["eq", ["staff_id", ME]]);
    const cols = String(lr.ops.find((o) => o[0] === "select")![1][0]);
    expect(cols).not.toMatch(/reason|notes/);
    expect(r.leave.workingDays).toBe(5);
    expect(r.leave.pendingRequests).toBe(1);
  });

  it("fails with an error (not zero leave) when leave can't be read", async () => {
    const { db } = mockDb({ leaveError: true });
    await expect(
      loadPracticeSummary(db as never, ME, "2030-04-01", "2031-03-31"),
    ).rejects.toThrow();
  });
});
