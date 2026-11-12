import { describe, expect, it } from "vitest";
import { summariseLeave, type PracticeLeaveRow } from "./leave-summary";

const leave = (o: Partial<PracticeLeaveRow>): PracticeLeaveRow => ({
  id: String(Math.random()),
  type: "annual",
  status: "approved",
  start_date: "2026-06-01",
  end_date: "2026-06-05",
  half_day_start: null,
  half_day_end: null,
  clwrota_external_id: "x",
  ...o,
});
const base = { from: "2026-04-01", to: "2027-03-31", today: "2026-11-12" };

describe("summariseLeave", () => {
  it("counts a Mon–Fri week of approved annual leave as 5 working days", () => {
    const r = summariseLeave({ ...base, rows: [leave({})] });
    expect(r.workingDays).toBe(5);
    expect(r.byType).toEqual([
      expect.objectContaining({
        type: "annual",
        requests: 1,
        workingDays: 5,
        plannedWorkingDays: 0,
      }),
    ]);
  });

  it("does not count weekend days", () => {
    // Fri 5 Jun – Mon 8 Jun 2026
    const r = summariseLeave({
      ...base,
      rows: [leave({ start_date: "2026-06-05", end_date: "2026-06-08" })],
    });
    expect(r.workingDays).toBe(2);
  });

  it("counts only the part of a request inside the chosen dates", () => {
    // Mon 30 Mar – Fri 3 Apr 2026: only 1–3 Apr fall in the appraisal year
    const r = summariseLeave({
      ...base,
      rows: [leave({ start_date: "2026-03-30", end_date: "2026-04-03" })],
    });
    expect(r.workingDays).toBe(3);
  });

  it("never adds pending, rejected or cancelled requests to the days", () => {
    const r = summariseLeave({
      ...base,
      rows: [
        leave({ status: "pending" }),
        leave({ status: "rejected" }),
        leave({ status: "cancelled" }),
      ],
    });
    expect(r.workingDays).toBe(0);
    expect(r.approvedRequests).toBe(0);
    expect(r.pendingRequests).toBe(1);
    expect(r.notTakenRequests).toBe(2);
  });

  it("splits out booked days still to come after today", () => {
    // Wed 11 – Tue 17 Nov 2026, today Thu 12 Nov: 5 working days, 3 after today (13, 16, 17)
    const r = summariseLeave({
      ...base,
      rows: [leave({ start_date: "2026-11-11", end_date: "2026-11-17" })],
    });
    expect(r.workingDays).toBe(5);
    expect(r.plannedWorkingDays).toBe(3);
  });

  it("takes half a day off for a half-day marker", () => {
    const r = summariseLeave({
      ...base,
      rows: [leave({ half_day_end: "am", clwrota_external_id: null })],
    });
    expect(r.workingDays).toBe(4.5);
    expect(r.withHalfDay).toBe(1);
    expect(r.fromClwrota).toBe(0);
  });

  it("counts a repeated request once and keeps types apart", () => {
    const a = leave({ id: "same" });
    const r = summariseLeave({
      ...base,
      rows: [a, a, leave({ type: "study", start_date: "2026-07-06", end_date: "2026-07-07" })],
    });
    expect(r.byType.map((l) => [l.type, l.workingDays])).toEqual([
      ["annual", 5],
      ["study", 2],
    ]);
    expect(r.workingDays).toBe(7);
  });

  it("ignores leave entirely outside the dates", () => {
    const r = summariseLeave({
      ...base,
      rows: [leave({ start_date: "2027-04-05", end_date: "2027-04-09" })],
    });
    expect(r.approvedRequests).toBe(0);
  });
});
