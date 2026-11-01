import { describe, expect, it } from "vitest";
import {
  computeWellbeing,
  MIN_ASSESSABLE_SESSIONS,
  wellbeingBandFor,
  type RotaAssignmentLite,
} from "./wellbeing-score";
import { selectAdminSignalInputs, type AdminLeaveRow } from "./admin-inputs";
import { attritionBandFor, computeAttritionRisk } from "@/lib/attrition-risk";

const S = "staff-synthetic";
const ASOF = new Date("2026-11-01T12:00:00Z"); // Sunday

function rows(dates: string[], session: string): RotaAssignmentLite[] {
  return dates.map((d) => ({ staff_id: S, session_date: d, session }));
}
const base = { staffId: S, changes: [], leave: [], exceptions: [] };
const unsocial = (r: ReturnType<typeof computeWellbeing>) =>
  r.drivers.find((d) => d.key === "unsocial")!.value;

// Saturdays/Sundays in Oct 2026: 3,4,10,11,17,18,24,25,31
const WEEKEND_DAYS = [
  "2026-10-03",
  "2026-10-04",
  "2026-10-10",
  "2026-10-11",
  "2026-10-17",
  "2026-10-18",
  "2026-10-24",
  "2026-10-25",
  "2026-10-31",
  "2026-11-01",
];
const WEEKDAYS = [
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
];

describe("unsocial share is a union of rows", () => {
  it("weekend nights only => 100%, not 200%", () => {
    const r = computeWellbeing({ ...base, now: ASOF, assignments: rows(WEEKEND_DAYS, "night") });
    expect(unsocial(r)).toBe(1);
  });
  it("mixed overlap: 2 weekend nights, 2 weekday eves, 2 weekend am, 4 weekday am => 60%", () => {
    const a = [
      ...rows(WEEKEND_DAYS.slice(0, 2), "night"),
      ...rows(WEEKDAYS.slice(0, 2), "eve"),
      ...rows(WEEKEND_DAYS.slice(2, 4), "am"),
      ...rows(WEEKDAYS.slice(2, 6), "am"),
    ];
    const r = computeWellbeing({ ...base, now: ASOF, assignments: a });
    expect(unsocial(r)).toBeCloseTo(0.6, 10);
  });
});

describe("90 inclusive calendar-day window", () => {
  // asOf 2026-11-01 ⇒ window 2026-08-04 .. 2026-11-01
  const edge = (d: string) => rows([d], "night");
  const pad = rows(WEEKDAYS, "am");
  for (const t of ["2026-11-01T00:00:00Z", "2026-11-01T12:00:00Z", "2026-11-01T23:59:59Z"]) {
    it(`same boundaries at ${t}`, () => {
      const r = computeWellbeing({
        ...base,
        now: new Date(t),
        assignments: [...pad, ...edge("2026-08-04"), ...edge("2026-08-03")],
      });
      expect(r.windowStart).toBe("2026-08-04");
      expect(r.windowEnd).toBe("2026-11-01");
      expect(r.drivers.find((d) => d.key === "nights")!.value).toBe(1);
    });
  }
});

describe("insufficient data is unknown, never Thriving 100", () => {
  it("empty input", () => {
    const r = computeWellbeing({ ...base, now: ASOF, assignments: [] });
    expect(r.scoreKnown).toBe(false);
    expect(r.band).toBe("unknown");
    expect(r.coverage).toBe("insufficient");
  });
  it("below minimum is unknown, at minimum is assessed", () => {
    const few = rows(WEEKDAYS.slice(0, MIN_ASSESSABLE_SESSIONS - 1), "am");
    expect(computeWellbeing({ ...base, now: ASOF, assignments: few }).band).toBe("unknown");
    const enough = rows(WEEKDAYS.slice(0, MIN_ASSESSABLE_SESSIONS), "am");
    expect(computeWellbeing({ ...base, now: ASOF, assignments: enough }).band).toBe("thriving");
  });
  it("retention signal is not assessed when wellbeing is unknown", () => {
    const wb = computeWellbeing({ ...base, now: ASOF, assignments: [] });
    const a = computeAttritionRisk({
      wellbeing: wb,
      bradfordScore: 0,
      denialRate12m: 0,
      shortNoticeChanges12m: 0,
      daysSinceLastAnnual: 10,
      overdueRtwCount: 0,
      pulseTrend: null,
    });
    expect(a.band).toBe("not_assessed");
    expect(a.notAssessed).toContain("pulse survey trend");
  });
});

describe("band thresholds unchanged", () => {
  it("wellbeing 80/65/45", () => {
    expect([80, 79, 65, 64, 45, 44].map(wellbeingBandFor)).toEqual([
      "thriving",
      "steady",
      "steady",
      "strained",
      "strained",
      "at_risk",
    ]);
  });
  it("retention 25 boundary uses displayed integer", () => {
    expect([24, 25, 44, 45, 64, 65].map(attritionBandFor)).toEqual([
      "low",
      "watch",
      "watch",
      "elevated",
      "elevated",
      "high",
    ]);
  });
  it("raw 0.2496 displays 25 and bands Watch (previously Low)", () => {
    // wellbeing 100 (0), bradford 0, denials 0, short 0, annual 0, rtw 0,
    // pulse missing 0.3*0.13=0.039, plus shortnotice x/20*0.12 → choose to land 0.2496.
    // Use annual days: 0.039 + d/180*0.10 + rtw 1/2*0.08 = 0.039+0.04+d/1800
    // ⇒ d/1800 = 0.1706 ⇒ d = 307.08 → clamp at 1 ⇒ use short-notice instead.
    const wb = computeWellbeing({ ...base, now: ASOF, assignments: rows(WEEKDAYS, "am") });
    expect(wb.score).toBe(100);
    // 0.039 + rtw 0.04 + annual(0.1*x) + short(0.12*y) = 0.2496
    // annual 180 days ⇒ 0.1 → 0.179; short y = 0.0706/0.12 = 0.58833 ⇒ 11.7667 changes (not integer)
    // So build via bradford: 0.15*b/400. 0.179 + 0.15*b/400 = 0.2496 ⇒ b = 188.27 → use b=188.
    const a = computeAttritionRisk({
      wellbeing: wb,
      bradfordScore: 188,
      denialRate12m: 0,
      shortNoticeChanges12m: 0,
      daysSinceLastAnnual: 180,
      overdueRtwCount: 1,
      pulseTrend: null,
    });
    expect(a.risk).toBeGreaterThan(0.249);
    expect(a.risk).toBeLessThan(0.25);
    expect(a.score).toBe(25);
    expect(a.band).toBe("watch");
  });
});

describe("admin 12-month signal selection", () => {
  const L = (o: Partial<AdminLeaveRow>): AdminLeaveRow => ({
    id: Math.random().toString(36),
    staff_id: S,
    type: "annual",
    status: "approved",
    start_date: "2026-10-01",
    end_date: "2026-10-02",
    created_at: null,
    decided_at: null,
    ...o,
  });
  const sel = (
    leave: AdminLeaveRow[],
    extra: Partial<Parameters<typeof selectAdminSignalInputs>[0]> = {},
  ) => selectAdminSignalInputs({ staffId: S, asOf: ASOF, leave, changes: [], rtws: [], ...extra });

  it("2023 denial + recent approval => 0% denial rate", () => {
    const r = sel([
      L({
        status: "rejected",
        start_date: "2023-05-01",
        end_date: "2023-05-02",
        decided_at: "2023-04-01T10:00:00Z",
      }),
      L({ decided_at: "2026-09-01T10:00:00Z" }),
    ]);
    expect(r.denialRate12m).toBe(0);
    expect(r.decisions12m).toBe(1);
  });
  it("decision date falls back to created_at then start_date", () => {
    const r = sel([
      L({
        status: "rejected",
        created_at: "2026-09-01T00:00:00Z",
        start_date: "2027-01-01",
        end_date: "2027-01-02",
      }),
    ]);
    expect(r.denialRate12m).toBe(1);
  });
  it("future annual booking does not reset 295 days", () => {
    const r = sel([
      L({ start_date: "2026-01-09", end_date: "2026-01-10" }),
      L({ start_date: "2026-12-20", end_date: "2026-12-24" }),
    ]);
    expect(r.daysSinceLastAnnual).toBe(295);
  });
  it("ongoing annual leave => 0 days", () => {
    expect(sel([L({ start_date: "2026-10-30", end_date: "2026-11-05" })]).daysSinceLastAnnual).toBe(
      0,
    );
  });
  it("only future annual => null (none taken)", () => {
    expect(
      sel([L({ start_date: "2026-12-20", end_date: "2026-12-24" })]).daysSinceLastAnnual,
    ).toBeNull();
  });
  it("RTW without conducted_at stays overdue", () => {
    const sick = L({ id: "sick1", type: "sick", start_date: "2026-10-01", end_date: "2026-10-03" });
    expect(
      sel([sick], { rtws: [{ leave_request_id: "sick1", conducted_at: null }] }).overdueRtwCount,
    ).toBe(1);
    expect(
      sel([sick], { rtws: [{ leave_request_id: "sick1", conducted_at: "2026-10-06T09:00:00Z" }] })
        .overdueRtwCount,
    ).toBe(0);
  });
  it("future rota change dates are excluded", () => {
    const r = sel([], {
      changes: [
        { staff_id: S, session_date: "2026-10-20", hours_before_session: 12 },
        { staff_id: S, session_date: "2026-11-03", hours_before_session: 12 },
      ],
    });
    expect(r.shortNoticeChanges12m).toBe(1);
  });
  it("pulse trend is reported unavailable", () => {
    expect(sel([]).pulseTrend).toBeNull();
  });
});
