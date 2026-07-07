import { describe, it, expect } from "vitest";
import {
  computeAllocationFairness,
  computeShortNotice,
  computeDenials,
  computeTraineeExposure,
  computeOnCallInequality,
  computeSicknessSeasonality,
  computeHandoverRisk,
  computeNewStarterWarnings,
  ltftFraction,
  classifyDenialReason,
  isoWeekendDay,
} from "./analyses";

describe("analytics-pack", () => {
  it("isoWeekendDay flags Sat/Sun", () => {
    expect(isoWeekendDay("2025-06-07")).toBe(true); // Sat
    expect(isoWeekendDay("2025-06-08")).toBe(true); // Sun
    expect(isoWeekendDay("2025-06-09")).toBe(false); // Mon
  });

  it("ltftFraction clamps", () => {
    expect(ltftFraction(null)).toBe(1);
    expect(ltftFraction(["mon"])).toBeCloseTo(0.8);
    expect(ltftFraction(["mon", "tue", "wed", "thu", "fri", "sat"])).toBe(0.1);
  });

  it("allocation fairness computes gini + weekend + on-call", () => {
    const rows = computeAllocationFairness([
      { staff_id: "a", session_date: "2025-06-02", duty_type: "theatre", role_on_list: "solo", specialty_id: "s1" },
      { staff_id: "a", session_date: "2025-06-03", duty_type: "theatre", role_on_list: "solo", specialty_id: "s1" },
      { staff_id: "a", session_date: "2025-06-07", duty_type: "theatre", role_on_list: "solo", specialty_id: "s1" }, // Sat
      { staff_id: "a", session_date: "2025-06-04", duty_type: "general_consultant_oncall", role_on_list: "on_call", specialty_id: null },
      { staff_id: "b", session_date: "2025-06-02", duty_type: "theatre", role_on_list: "solo", specialty_id: "s1" },
      { staff_id: "b", session_date: "2025-06-03", duty_type: "theatre", role_on_list: "solo", specialty_id: "s2" },
    ]);
    const a = rows.find((r) => r.staff_id === "a")!;
    expect(a.totalSessions).toBe(4);
    expect(a.weekendCount).toBe(1);
    expect(a.onCallCount).toBe(1);
    const b = rows.find((r) => r.staff_id === "b")!;
    expect(b.listTypeGini).toBe(0); // even split
    expect(a.listTypeGini).toBeGreaterThan(0);
  });

  it("short-notice filters >48h and buckets by action", () => {
    const agg = computeShortNotice([
      { staff_id: "a", action: "insert", hours_before_session: 12, changed_at: "2025-06-01T00:00:00Z" },
      { staff_id: "a", action: "delete", hours_before_session: 6, changed_at: "2025-06-02T00:00:00Z" },
      { staff_id: "a", action: "insert", hours_before_session: 200, changed_at: "2025-06-03T00:00:00Z" }, // dropped
      { staff_id: "b", action: "insert", hours_before_session: 24, changed_at: "2025-06-04T00:00:00Z" },
    ]);
    expect(agg[0].staff_id).toBe("a");
    expect(agg[0].totalShortNotice).toBe(2);
    expect(agg[0].added).toBe(1);
    expect(agg[0].removed).toBe(1);
  });

  it("classifyDenialReason buckets", () => {
    expect(classifyDenialReason("rota is short")).toBe("rota pressure");
    expect(classifyDenialReason("clashes with X")).toBe("conflict with other leave");
    expect(classifyDenialReason(null)).toBe("unspecified");
    expect(classifyDenialReason("random text")).toBe("other");
  });

  it("computeDenials aggregates category + month + grade", () => {
    const out = computeDenials([
      { status: "rejected", decided_at: "2025-06-05T00:00:00Z", decision_notes: "rota short", grade: "consultant" },
      { status: "rejected", decided_at: "2025-06-15T00:00:00Z", decision_notes: "clash", grade: "trainee" },
      { status: "approved", decided_at: "2025-06-20T00:00:00Z", decision_notes: null, grade: "trainee" },
    ]);
    expect(out.total).toBe(2);
    expect(out.byMonth.find((m) => m.month === "2025-06")!.count).toBe(2);
  });

  it("trainee exposure bands", () => {
    const out = computeTraineeExposure({
      trainees: [{ id: "t1", training_level: "CT1" }],
      assignments: [
        { staff_id: "t1", specialty_id: "obs" },
        { staff_id: "t1", specialty_id: "obs" },
        { staff_id: "t1", specialty_id: "cardiac" },
      ],
      targets: [
        { training_level: "CT1", specialty_id: "obs", required_sessions: 2 },
        { training_level: "CT1", specialty_id: "cardiac", required_sessions: 5 },
      ],
    });
    const t = out[0];
    const obs = t.bySpecialty.find((s) => s.specialty_id === "obs")!;
    const card = t.bySpecialty.find((s) => s.specialty_id === "cardiac")!;
    expect(obs.band).toBe("green");
    expect(card.band).toBe("red");
    expect(t.underexposedCount).toBe(1);
  });

  it("on-call inequality flags outliers", () => {
    const r = computeOnCallInequality({
      consultants: [
        { id: "a", ltft_days_off: null },
        { id: "b", ltft_days_off: null },
        { id: "c", ltft_days_off: null },
      ],
      onCallRows: [
        ...Array(10).fill({ staff_id: "a" }),
        ...Array(5).fill({ staff_id: "b" }),
        ...Array(4).fill({ staff_id: "c" }),
      ],
    });
    expect(r.rows[0].staff_id).toBe("a");
    expect(r.rows[0].outlier).toBe(true);
  });

  it("sickness seasonality pairs months with rota density", () => {
    const r = computeSicknessSeasonality({
      sickRows: [
        { start_date: "2025-01-01", end_date: "2025-01-03" },
        { start_date: "2025-02-10", end_date: "2025-02-10" },
      ],
      rotaRows: [
        { session_date: "2025-01-05" },
        { session_date: "2025-02-05" },
        { session_date: "2025-03-05" },
      ],
    });
    expect(r.cells.find((c) => c.month === "2025-01")!.absenceDays).toBe(3);
  });

  it("handover risk detects back-to-back high-acuity", () => {
    const r = computeHandoverRisk([
      { staff_id: "c1", session_date: "2025-06-02", session: "am", specialty_name: "Trauma" },
      { staff_id: "c1", session_date: "2025-06-02", session: "pm", specialty_name: "Cardiac" },
      { staff_id: "c1", session_date: "2025-06-03", session: "am", specialty_name: "Ortho" },
      { staff_id: "c1", session_date: "2025-06-03", session: "pm", specialty_name: "Cardiac" },
    ]);
    expect(r[0].events).toBe(1);
  });

  it("new-starter score combines signals", () => {
    const now = new Date("2025-07-01T00:00:00Z");
    const r = computeNewStarterWarnings({
      newStarters: [{ id: "n1", start_date: "2025-05-01" }],
      sickRows: [{ staff_id: "n1", start_date: "2025-05-10", end_date: "2025-05-12" }],
      exceptionRows: [{ trainee_id: "n1", created_at: "2025-05-20T00:00:00Z" }],
      shortNoticeRows: [
        { staff_id: "n1", action: "insert", hours_before_session: 12, changed_at: "2025-05-15T00:00:00Z" },
      ],
      now,
    });
    expect(r[0].sicknessDays).toBe(3);
    expect(r[0].exceptionReports).toBe(1);
    expect(r[0].shortNoticeReceived).toBe(1);
    expect(r[0].score).toBeGreaterThan(0);
  });
});
