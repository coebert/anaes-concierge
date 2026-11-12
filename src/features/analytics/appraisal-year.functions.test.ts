/**
 * Appraisal-year server loader: who may read whose year, server-side
 * filtering, failures surfacing, and no raw rows leaving the server. Synthetic.
 */
import { describe, expect, it } from "vitest";
import { loadAppraisalStaff, loadAppraisalYear } from "./appraisal-year.functions";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2027-01-10T12:00:00Z");

type Call = { table: string; ops: Array<[string, unknown[]]> };
function mockDb(
  opts: {
    grade?: string | null;
    missingProfile?: boolean;
    rulesError?: boolean;
    rowsError?: boolean;
    rows?: Record<string, unknown>[];
  } = {},
) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "lte", "or", "in", "order", "limit"])
        b[m] = (...a: unknown[]) => (call.ops.push([m, a]), b);
      b.maybeSingle = async () => {
        if (table === "rota_rules")
          return opts.rulesError
            ? { data: null, error: { message: "denied" } }
            : {
                data: { sessions_per_pa: 1, oncall_pa_credit: 1.5, weekend_pa_credit: 3 },
                error: null,
              };
        if (table === "profiles")
          return {
            data: opts.missingProfile
              ? null
              : { full_name: "Synthetic Doctor", grade: opts.grade ?? "consultant" },
            error: null,
          };
        return { data: null, error: null };
      };
      b.range = async (a: number) => {
        if (table === "rota_assignments" && opts.rowsError)
          return { data: null, error: { message: "timeout" } };
        if (a > 0) return { data: [], error: null };
        if (table === "rota_assignments") return { data: opts.rows ?? [], error: null };
        if (table === "theatre_sessions")
          return { data: [{ id: "L1", specialties: { name: "Synthetic Gynae" } }], error: null };
        if (table === "profiles")
          return { data: [{ id: OTHER, full_name: "Synthetic Other" }], error: null };
        return { data: [], error: null };
      };
      return b;
    },
  };
  return { db: db as never, calls };
}

const row = (o: Record<string, unknown>) => ({
  id: String(Math.random()),
  staff_id: ME,
  session_date: "2026-05-04",
  session: "am",
  duty_type: "theatre",
  extra_type: null,
  pa_credit: 1,
  attending_consultant_ids: null,
  theatre_session_id: "L1",
  ...o,
});

const doctor = { userId: ME, roles: new Set(["doctor"]) };
const coordinator = { userId: ME, roles: new Set(["rota_coordinator"]) };

describe("loadAppraisalYear", () => {
  it("reads the caller's own year scoped on the server to the caller and that April–March", async () => {
    const { db, calls } = mockDb({ rows: [row({})] });
    const r = await loadAppraisalYear(db, doctor, { year: 2026 }, NOW);
    expect(r.staffId).toBe(ME);
    const read = calls.find((c) => c.table === "rota_assignments")!;
    expect(read.ops).toContainEqual(["gte", ["session_date", "2026-04-01"]]);
    expect(read.ops).toContainEqual(["lte", ["session_date", "2027-03-31"]]);
    expect(read.ops).toContainEqual([
      "or",
      [`staff_id.eq.${ME},attending_consultant_ids.cs.{${ME}}`],
    ]);
  });

  it("refuses another doctor's year to a caller without a coordinator role", async () => {
    const { db, calls } = mockDb();
    await expect(
      loadAppraisalYear(db, doctor, { year: 2026, staffId: OTHER }, NOW),
    ).rejects.toThrow("Forbidden");
    expect(calls.some((c) => c.table === "rota_assignments")).toBe(false);
  });

  it("lets an admin or rota coordinator read another doctor's year", async () => {
    for (const roles of [new Set(["admin"]), new Set(["rota_coordinator"])]) {
      const { db, calls } = mockDb();
      const r = await loadAppraisalYear(
        db,
        { userId: ME, roles },
        { year: 2026, staffId: OTHER },
        NOW,
      );
      expect(r.staffId).toBe(OTHER);
      const read = calls.find((c) => c.table === "rota_assignments")!;
      expect(read.ops).toContainEqual([
        "or",
        [`staff_id.eq.${OTHER},attending_consultant_ids.cs.{${OTHER}}`],
      ]);
    }
  });

  it("refuses a non-coordinator whose grade is not consultant or SAS", async () => {
    const { db } = mockDb({ grade: "trainee" });
    await expect(loadAppraisalYear(db, doctor, { year: 2026 }, NOW)).rejects.toThrow("Forbidden");
  });

  it("counts only the chosen doctor's work and returns no raw rows or other doctors' ids", async () => {
    const { db } = mockDb({
      rows: [
        row({ staff_id: ME, session: "am" }),
        row({ staff_id: ME, session: "pm", session_date: "2026-05-05" }),
        row({ staff_id: OTHER, attending_consultant_ids: [ME], session_date: "2026-06-01" }),
      ],
    });
    const r = await loadAppraisalYear(db, coordinator, { year: 2026, staffId: ME }, NOW);
    expect(r.summary.overall.sessions).toBe(3);
    expect(JSON.stringify(r)).not.toContain(OTHER);
    expect(r).not.toHaveProperty("rows");
  });

  it("rejects years outside the selectable range", async () => {
    const { db } = mockDb();
    await expect(loadAppraisalYear(db, doctor, { year: 2014 }, NOW)).rejects.toThrow();
    await expect(loadAppraisalYear(db, doctor, { year: 2028 }, NOW)).rejects.toThrow();
  });

  it("surfaces a PA settings failure instead of using default rates", async () => {
    const { db } = mockDb({ rulesError: true });
    await expect(loadAppraisalYear(db, doctor, { year: 2026 }, NOW)).rejects.toThrow(
      "PA settings could not be loaded",
    );
  });

  it("surfaces a rota read failure instead of an empty year", async () => {
    const { db } = mockDb({ rowsError: true });
    await expect(loadAppraisalYear(db, doctor, { year: 2026 }, NOW)).rejects.toThrow();
  });

  it("says when the chosen doctor does not exist", async () => {
    const { db } = mockDb({ missingProfile: true });
    await expect(
      loadAppraisalYear(db, coordinator, { year: 2026, staffId: OTHER }, NOW),
    ).rejects.toThrow("could not be found");
  });
});

describe("loadAppraisalStaff", () => {
  it("is only for admins and rota coordinators", async () => {
    const { db } = mockDb();
    await expect(loadAppraisalStaff(db, new Set(["doctor"]))).rejects.toThrow("Forbidden");
    expect(await loadAppraisalStaff(db, new Set(["admin"]))).toEqual([
      { id: OTHER, full_name: "Synthetic Other" },
    ]);
  });
});
