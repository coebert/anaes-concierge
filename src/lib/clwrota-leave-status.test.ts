import { describe, it, expect } from "vitest";
import { classifyLeaveType, classifyLeaveStatus } from "./clwrota-leave-classify";
import { summariseStaffLeave, remaining } from "@/features/leave/leave-allowances";

/**
 * Regression tests for the CLWRota status pipeline: only `approved` leave
 * should deduct allowances (→ `taken`); `pending` is held as `booked`;
 * `rejected` and `cancelled` must be ignored entirely across all three
 * buckets (annual, study, professional).
 *
 * Pinning this down prevents two classes of regression:
 *  1. classifyLeaveStatus mapping drift (e.g. a synonym for "rejected"
 *     accidentally falling through to the default "approved").
 *  2. summariseStaffLeave starting to count non-approved rows toward
 *     `taken`, which would silently inflate consumed allowance.
 */

const STAFF = "staff-status";
const YEAR_START = "2026-04-01";

type Row = {
  typeRaw: string;
  reason: string | null;
  statusRaw: string | null;
  start: string;
  end: string;
};

function buildRows(input: Row[]) {
  return input.map((r, i) => ({
    staff_id: STAFF,
    type: classifyLeaveType(r.typeRaw, r.reason),
    status: classifyLeaveStatus(r.statusRaw),
    start_date: r.start,
    end_date: r.end,
    half_day_start: null,
    half_day_end: null,
    clwrota_external_id: `ext-${i}`,
  }));
}

describe("CLWRota status → allowance impact (only approved deducts)", () => {
  it("approved leave lands in `taken` for every bucket", () => {
    const rows = buildRows([
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Approved", start: "2026-04-06", end: "2026-04-10" }, // 5 wd
      { typeRaw: "Study Leave", reason: "Salisbury Regional Anaesthesia Course", statusRaw: "Granted", start: "2026-05-04", end: "2026-05-06" }, // 3 wd
      { typeRaw: "Study Leave", reason: "ALS Faculty Salisbury", statusRaw: "OK", start: "2026-06-08", end: "2026-06-09" }, // 2 wd
    ]);
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.annual).toEqual({ taken: 5, booked: 0 });
    expect(s.study).toEqual({ taken: 3, booked: 0 });
    expect(s.professional).toEqual({ taken: 2, booked: 0 });
  });

  it("pending leave lands in `booked`, never `taken`, across all buckets", () => {
    const rows = buildRows([
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Pending approval", start: "2026-04-06", end: "2026-04-07" }, // 2 wd
      { typeRaw: "Study Leave", reason: null, statusRaw: "Awaiting decision", start: "2026-05-04", end: "2026-05-04" }, // 1 wd
      { typeRaw: "Study Leave", reason: "Teaching on STIVA", statusRaw: "Requested", start: "2026-06-08", end: "2026-06-08" }, // 1 wd prof
    ]);
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.annual).toEqual({ taken: 0, booked: 2 });
    expect(s.study).toEqual({ taken: 0, booked: 1 });
    expect(s.professional).toEqual({ taken: 0, booked: 1 });
  });

  it("rejected leave is ignored across all buckets (no taken, no booked)", () => {
    const rows = buildRows([
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Rejected", start: "2026-04-06", end: "2026-04-10" },
      { typeRaw: "Study Leave", reason: null, statusRaw: "Declined", start: "2026-05-04", end: "2026-05-08" },
      { typeRaw: "Study Leave", reason: "ALS Faculty", statusRaw: "Denied", start: "2026-06-08", end: "2026-06-12" },
    ]);
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.annual).toEqual({ taken: 0, booked: 0 });
    expect(s.study).toEqual({ taken: 0, booked: 0 });
    expect(s.professional).toEqual({ taken: 0, booked: 0 });
  });

  it("cancelled / withdrawn leave is ignored across all buckets", () => {
    const rows = buildRows([
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Cancelled", start: "2026-04-06", end: "2026-04-10" },
      { typeRaw: "Study Leave", reason: null, statusRaw: "Withdrawn", start: "2026-05-04", end: "2026-05-08" },
      { typeRaw: "Study Leave", reason: "Instructor on EPALS", statusRaw: "Cancelled", start: "2026-06-08", end: "2026-06-12" },
    ]);
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.annual).toEqual({ taken: 0, booked: 0 });
    expect(s.study).toEqual({ taken: 0, booked: 0 });
    expect(s.professional).toEqual({ taken: 0, booked: 0 });
  });

  it("mixed statuses on the same bucket only deduct approved rows", () => {
    const rows = buildRows([
      // Annual: 5 approved + 2 pending + (3 rejected + 4 cancelled ignored)
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Approved", start: "2026-04-06", end: "2026-04-10" },     // 5
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Pending", start: "2026-04-13", end: "2026-04-14" },      // 2
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Rejected", start: "2026-04-20", end: "2026-04-22" },     // 3 ignored
      { typeRaw: "Annual Leave", reason: null, statusRaw: "Cancelled", start: "2026-04-27", end: "2026-04-30" },    // 4 ignored
      // Study: 2 approved + 1 pending + 5 cancelled ignored
      { typeRaw: "Study Leave", reason: null, statusRaw: "Granted", start: "2026-05-04", end: "2026-05-05" },       // 2
      { typeRaw: "Study Leave", reason: null, statusRaw: "Awaiting", start: "2026-05-11", end: "2026-05-11" },      // 1
      { typeRaw: "Study Leave", reason: null, statusRaw: "Withdrawn", start: "2026-05-18", end: "2026-05-22" },     // 5 ignored
      // Professional: 2 approved + 1 pending + 1 rejected ignored
      { typeRaw: "Study Leave", reason: "Teaching on STIVA", statusRaw: "Approved", start: "2026-06-08", end: "2026-06-09" }, // 2
      { typeRaw: "Study Leave", reason: "ALS Faculty", statusRaw: "Pending", start: "2026-06-15", end: "2026-06-15" },         // 1
      { typeRaw: "Study Leave", reason: "Organising above course", statusRaw: "Declined", start: "2026-06-22", end: "2026-06-22" }, // ignored
    ]);
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);

    expect(s.annual).toEqual({ taken: 5, booked: 2 });
    expect(s.study).toEqual({ taken: 2, booked: 1 });
    expect(s.professional).toEqual({ taken: 2, booked: 1 });

    // Remaining must subtract both taken and booked, never the ignored rows.
    expect(remaining(s.annualAllowance, s.annual)).toBe(27 - 5 - 2);
    expect(remaining(s.studyAllowance, s.study)).toBe(10 - 2 - 1);
    expect(remaining(s.professionalAllowance, s.professional)).toBe(5 - 2 - 1);
  });

  it("CLWRota's blank/missing status defaults to approved (published feed)", () => {
    // CLWRota only publishes already-approved leave, so an empty status
    // must still deduct allowance. If this ever flips, every synced row
    // would silently stop counting.
    const rows = buildRows([
      { typeRaw: "Annual Leave", reason: null, statusRaw: null, start: "2026-04-06", end: "2026-04-08" },  // 3
      { typeRaw: "Study Leave", reason: null, statusRaw: "", start: "2026-05-04", end: "2026-05-04" },     // 1
      { typeRaw: "Study Leave", reason: "Teaching on STIVA", statusRaw: "   ", start: "2026-06-08", end: "2026-06-08" }, // 1
    ]);
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.annual.taken).toBe(3);
    expect(s.study.taken).toBe(1);
    expect(s.professional.taken).toBe(1);
    expect(s.annual.booked + s.study.booked + s.professional.booked).toBe(0);
  });

  it("unknown status strings still fall back to approved and deduct allowance", () => {
    const rows = buildRows([
      { typeRaw: "Annual Leave", reason: null, statusRaw: "qwerty", start: "2026-04-06", end: "2026-04-08" },   // 3
      { typeRaw: "Study Leave", reason: null, statusRaw: "12345", start: "2026-05-04", end: "2026-05-04" },     // 1
      { typeRaw: "Study Leave", reason: "Teaching on STIVA", statusRaw: "🚀", start: "2026-06-08", end: "2026-06-08" }, // 1
    ]);
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.annual.taken).toBe(3);
    expect(s.study.taken).toBe(1);
    expect(s.professional.taken).toBe(1);
    expect(s.annual.booked + s.study.booked + s.professional.booked).toBe(0);
  });

  it("flipping a row's status from approved → cancelled on resync removes the deduction", () => {
    // Simulates the nightly sync re-receiving the same `clwrota_external_id`
    // with an updated status — the aggregator must reflect the new status
    // immediately and stop counting the row.
    const day = { typeRaw: "Annual Leave", reason: null, start: "2026-04-06", end: "2026-04-10" };

    const approved = buildRows([{ ...day, statusRaw: "Approved" }]);
    const cancelled = buildRows([{ ...day, statusRaw: "Cancelled" }]);

    const sA = summariseStaffLeave(STAFF, approved, undefined, YEAR_START);
    const sC = summariseStaffLeave(STAFF, cancelled, undefined, YEAR_START);

    expect(sA.annual).toEqual({ taken: 5, booked: 0 });
    expect(sC.annual).toEqual({ taken: 0, booked: 0 });
    expect(remaining(sC.annualAllowance, sC.annual)).toBe(27);
  });
});
