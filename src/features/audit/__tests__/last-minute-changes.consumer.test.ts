import { beforeEach, describe, expect, it, vi } from "vitest";

// Run the REAL handler: createServerFn/middleware are reduced to a call
// that passes a synthetic supabase client as context.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    type Fn = (a: unknown) => unknown;
    const b = {
      v: ((x: unknown) => x) as Fn,
      middleware: () => b,
      inputValidator: (v: Fn) => ((b.v = v), b),
      handler:
        (h: Fn) =>
        (d: { data: unknown; supabase: unknown }) =>
          h({ data: b.v(d.data), context: { supabase: d.supabase } }),
    };
    return b;
  },
}));
vi.mock("@/lib/require-admin", () => ({ requireActiveMember: {} }));

import { getLastMinuteChangesAudit } from "../last-minute-changes.functions";

type Log = Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const log = (i: number, staff: string, sess: string | null): Log => ({
  id: uuid(100000 + i),
  action: "update",
  session_date: "2026-10-05",
  session: "AM",
  staff_id: staff,
  session_start_ts: "2026-10-05T08:00:00Z",
  changed_at: "2026-10-04T09:00:00Z",
  hours_before_session: 23,
  changed_by: null,
  prev_theatre_session_id: sess,
  new_theatre_session_id: null,
  prev_staff_id: null,
});

let logs: Log[] = [];
let failLogsFrom: number | null = null;
let missingProfile: string | null = null;
const inSizes: Record<string, number[]> = { profiles: [], theatre_sessions: [] };

function client() {
  return {
    from(table: string) {
      let inIds: string[] = [];
      const b: Record<string, unknown> = {};
      for (const m of ["select", "gte", "lte", "order", "eq"]) b[m] = () => b;
      b.in = (_c: string, ids: string[]) => {
        inIds = ids;
        inSizes[table]?.push(ids.length);
        return b;
      };
      b.range = async (from: number, to: number) =>
        failLogsFrom !== null && from >= failLogsFrom
          ? { data: null, error: { message: `rota_change_log page at ${from} failed` } }
          : { data: logs.slice(from, to + 1), error: null };
      b.then = (res: (v: unknown) => void) => {
        const data =
          table === "profiles"
            ? inIds
                .filter((id) => id !== missingProfile)
                .map((id) => ({ id, full_name: `Synthetic ${id.slice(-4)}`, grade: "consultant" }))
            : inIds.map((id) => ({
                id,
                theatre_id: null,
                specialty_id: null,
                theatres: { name: "Theatre 1" },
                specialties: null,
              }));
        res({ data, error: null });
      };
      return b;
    },
  };
}

const run = () =>
  (getLastMinuteChangesAudit as unknown as (a: unknown) => Promise<{ totals: { all: number } }>)({
    data: { rangeStart: "2026-10-01", rangeEnd: "2026-10-31" },
    supabase: client(),
  });

beforeEach(() => {
  failLogsFrom = null;
  missingProfile = null;
  inSizes.profiles = [];
  inSizes.theatre_sessions = [];
  // 2,500 synthetic changes across 450 staff and 450 lists (multi-page).
  logs = Array.from({ length: 2500 }, (_, i) => log(i, uuid(i % 450), uuid(5000 + (i % 450))));
});

describe("last-minute changes audit consumer", () => {
  it("counts every row across pages and batches lookups ≤200 ids", async () => {
    const out = await run();
    expect(out.totals.all).toBe(2500);
    expect(inSizes.profiles).toEqual([200, 200, 50]);
    expect(inSizes.theatre_sessions).toEqual([200, 200, 50]);
  });

  it("page-2 failure is an error, never a zero-total report", async () => {
    failLogsFrom = 1000;
    await expect(run()).rejects.toThrow();
  });

  it("missing required staff attribution rejects rather than dropping rows", async () => {
    missingProfile = uuid(7);
    await expect(run()).rejects.toThrow(/required record/);
  });

  it("a malformed row rejects rather than silently shrinking totals", async () => {
    logs[1500] = { ...logs[1500], session_date: 42 };
    await expect(run()).rejects.toThrow(/malformed/);
  });
});
