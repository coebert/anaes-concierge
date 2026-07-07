/**
 * Unit tests for half-day leave that spans a week boundary
 * (Fri PM → next-Mon AM), verifying:
 *
 *   1. `countWorkingDays` clips the intervening Sat/Sun and applies both
 *      half-day markers on the boundary days.
 *   2. `computeLeaveConflicts` resolves rota conflicts on Fri (only PM,
 *      matching `half_day_start='pm'`) AND on Mon (only AM, matching
 *      `half_day_end='am'`), while surfacing other staff's approved
 *      leave overlapping Sat/Sun as `all_day` conflicts.
 *
 * The Supabase client is mocked with a minimal chainable stub that
 * returns per-table fixtures. The stub honours `.eq`, `.neq`, `.gte`,
 * `.lte`, `.in`, and awaits as `{ data, error }`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --------------------- fixture types ---------------------

type Assignment = {
  session_date: string;
  session: "am" | "pm";
  role_on_list: string | null;
  theatre_session_id: string | null;
  staff_id: string;
};
type TheatreSession = { id: string; theatre_id: string };
type Theatre = { id: string; name: string };
type Leave = {
  id: string;
  staff_id: string;
  start_date: string;
  end_date: string;
  status: "approved" | "pending" | "cancelled";
  type: string;
};
type Profile = { id: string; full_name: string };

interface Fixture {
  rota_assignments: Assignment[];
  theatre_sessions: TheatreSession[];
  theatres: Theatre[];
  leave_requests: Leave[];
  profiles: Profile[];
}

let fixture: Fixture = {
  rota_assignments: [],
  theatre_sessions: [],
  theatres: [],
  leave_requests: [],
  profiles: [],
};

// --------------------- chainable mock ---------------------

function makeChain(table: keyof Fixture) {
  const filters: {
    eq: Array<[string, unknown]>;
    neq: Array<[string, unknown]>;
    gte: Array<[string, string]>;
    lte: Array<[string, string]>;
    in: Array<[string, unknown[]]>;
  } = { eq: [], neq: [], gte: [], lte: [], in: [] };
  const resolve = () => {
    let rows = (fixture[table] ?? []) as unknown[];
    for (const [col, val] of filters.eq) {
      rows = rows.filter((r) => (r as Record<string, unknown>)[col] === val);
    }
    for (const [col, val] of filters.neq) {
      rows = rows.filter((r) => (r as Record<string, unknown>)[col] !== val);
    }
    for (const [col, val] of filters.gte) {
      rows = rows.filter(
        (r) => String((r as Record<string, unknown>)[col]) >= val,
      );
    }
    for (const [col, val] of filters.lte) {
      rows = rows.filter(
        (r) => String((r as Record<string, unknown>)[col]) <= val,
      );
    }
    for (const [col, vals] of filters.in) {
      const set = new Set(vals);
      rows = rows.filter((r) => set.has((r as Record<string, unknown>)[col]));
    }
    return Promise.resolve({ data: rows, error: null });
  };
  const chain: any = {
    select: () => chain,
    eq: (c: string, v: unknown) => (filters.eq.push([c, v]), chain),
    neq: (c: string, v: unknown) => (filters.neq.push([c, v]), chain),
    gte: (c: string, v: string) => (filters.gte.push([c, v]), chain),
    lte: (c: string, v: string) => (filters.lte.push([c, v]), chain),
    in: (c: string, v: unknown[]) => (filters.in.push([c, v]), chain),
    then: (onFulfilled: any, onRejected?: any) =>
      resolve().then(onFulfilled, onRejected),
  };
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeChain(table as keyof Fixture),
  },
}));

import { computeLeaveConflicts, countWorkingDays } from "./leave-utils";

// --------------------- constants ---------------------

const STAFF_ID = "self-1";
const OTHER_ID = "other-1";
const THEATRE_ID = "t-main";
const TS_FRI_AM = "ts-fri-am";
const TS_FRI_PM = "ts-fri-pm";
const TS_MON_AM = "ts-mon-am";
const TS_MON_PM = "ts-mon-pm";

const FRI = "2026-01-09";
const SAT = "2026-01-10";
const SUN = "2026-01-11";
const MON = "2026-01-12";

beforeEach(() => {
  fixture = {
    rota_assignments: [
      {
        staff_id: STAFF_ID,
        session_date: FRI,
        session: "am",
        role_on_list: "solo",
        theatre_session_id: TS_FRI_AM,
      },
      {
        staff_id: STAFF_ID,
        session_date: FRI,
        session: "pm",
        role_on_list: "solo",
        theatre_session_id: TS_FRI_PM,
      },
      {
        staff_id: STAFF_ID,
        session_date: MON,
        session: "am",
        role_on_list: "solo",
        theatre_session_id: TS_MON_AM,
      },
      {
        staff_id: STAFF_ID,
        session_date: MON,
        session: "pm",
        role_on_list: "solo",
        theatre_session_id: TS_MON_PM,
      },
    ],
    theatre_sessions: [
      { id: TS_FRI_AM, theatre_id: THEATRE_ID },
      { id: TS_FRI_PM, theatre_id: THEATRE_ID },
      { id: TS_MON_AM, theatre_id: THEATRE_ID },
      { id: TS_MON_PM, theatre_id: THEATRE_ID },
    ],
    theatres: [{ id: THEATRE_ID, name: "Main 1" }],
    leave_requests: [],
    profiles: [{ id: OTHER_ID, full_name: "Dr Colleague" }],
  };
});

describe("countWorkingDays across a week boundary", () => {
  it("counts Fri + Mon as 2 working days without any half-day markers", () => {
    expect(countWorkingDays(FRI, MON, null, null)).toBe(2);
  });

  it("clips to 1 working day when start is PM-only and end is AM-only", () => {
    // Fri 0.5 + Sat 0 (weekend) + Sun 0 + Mon 0.5 = 1
    expect(countWorkingDays(FRI, MON, "pm", "am")).toBe(1);
  });

  it("clips to 1.5 with only the start marker applied", () => {
    // Fri 0.5 + Mon 1 = 1.5
    expect(countWorkingDays(FRI, MON, "pm", null)).toBe(1.5);
  });
});

describe("computeLeaveConflicts across a week boundary — rota conflicts", () => {
  it("without half-day markers, both Fri and Mon halves (4 total) conflict", async () => {
    const conflicts = await computeLeaveConflicts(STAFF_ID, FRI, MON, null, null);
    const rota = conflicts.filter((c) => c.type === "rota_assignment");
    expect(rota.map((c) => `${c.date}|${c.session}`).sort()).toEqual([
      `${FRI}|am`,
      `${FRI}|pm`,
      `${MON}|am`,
      `${MON}|pm`,
    ]);
    // Sorted by date.
    expect(rota[0].date).toBe(FRI);
    expect(rota[rota.length - 1].date).toBe(MON);
    // Theatre name resolved via join.
    expect(rota[0].theatre).toBe("Main 1");
  });

  it("with half_day_start='pm' + half_day_end='am', only Fri PM and Mon AM conflict", async () => {
    const conflicts = await computeLeaveConflicts(STAFF_ID, FRI, MON, "pm", "am");
    const rota = conflicts.filter((c) => c.type === "rota_assignment");
    expect(rota.map((c) => `${c.date}|${c.session}`).sort()).toEqual([
      `${FRI}|pm`,
      `${MON}|am`,
    ]);
  });

  it("half-day markers do not affect intermediate days (there are none for a Fri→Mon range)", async () => {
    // Explicitly assert no Sat/Sun rota conflicts (matches the fixture),
    // guarding against regressions where midway days are mis-clipped.
    const conflicts = await computeLeaveConflicts(STAFF_ID, FRI, MON, "pm", "am");
    const midway = conflicts.filter(
      (c) =>
        c.type === "rota_assignment" &&
        (c.date === SAT || c.date === SUN),
    );
    expect(midway).toEqual([]);
  });
});

describe("computeLeaveConflicts across a week boundary — other staff leave", () => {
  it("surfaces overlapping approved leave on Sat and Sun as all_day conflicts", async () => {
    fixture.leave_requests.push({
      id: "L1",
      staff_id: OTHER_ID,
      start_date: SAT,
      end_date: SUN,
      status: "approved",
      type: "annual",
    });
    const conflicts = await computeLeaveConflicts(STAFF_ID, FRI, MON, "pm", "am");
    const other = conflicts.filter((c) => c.type === "other_leave");
    expect(other.map((c) => c.date).sort()).toEqual([SAT, SUN]);
    expect(other.every((c) => c.session === "all_day")).toBe(true);
    expect(other[0].staffName).toBe("Dr Colleague");
  });

  it("clips other-staff overlap to the requested range even when their leave extends past both ends", async () => {
    // Colleague's leave 2026-01-05 .. 2026-01-16 fully contains our Fri..Mon.
    fixture.leave_requests.push({
      id: "L2",
      staff_id: OTHER_ID,
      start_date: "2026-01-05",
      end_date: "2026-01-16",
      status: "approved",
      type: "annual",
    });
    const conflicts = await computeLeaveConflicts(STAFF_ID, FRI, MON, "pm", "am");
    const other = conflicts.filter((c) => c.type === "other_leave");
    // One row per day inside our requested window (Fri..Mon = 4 days).
    expect(other.map((c) => c.date).sort()).toEqual([FRI, SAT, SUN, MON]);
  });

  it("ignores non-approved other-staff leave (pending/cancelled)", async () => {
    fixture.leave_requests.push({
      id: "L3",
      staff_id: OTHER_ID,
      start_date: SAT,
      end_date: SUN,
      status: "pending",
      type: "annual",
    });
    const conflicts = await computeLeaveConflicts(STAFF_ID, FRI, MON, "pm", "am");
    const other = conflicts.filter((c) => c.type === "other_leave");
    expect(other).toEqual([]);
  });
});
