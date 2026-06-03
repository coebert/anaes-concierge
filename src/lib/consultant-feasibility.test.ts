import { describe, it, expect } from "vitest";
import {
  calculateFeasibility,
  FEASIBILITY_DEFAULTS,
  type FeasibilityInputs,
} from "./consultant-feasibility";

const close = (a: number, b: number, eps = 1e-6) =>
  Math.abs(a - b) < eps;

describe("calculateFeasibility — capacity breakdown", () => {
  it("derives the capacity waterfall consistently from gross to residual", () => {
    const r = calculateFeasibility(FEASIBILITY_DEFAULTS);

    // gross - leaveLost === afterLeave
    expect(
      close(
        r.grossAnnualSessionsPerConsultant -
          r.leaveLostAnnualSessionsPerConsultant,
        r.afterLeaveAnnualSessionsPerConsultant,
      ),
    ).toBe(true);

    // afterLeave - sicknessLost === net (annualSessionsPerConsultant)
    expect(
      close(
        r.afterLeaveAnnualSessionsPerConsultant -
          r.sicknessLostAnnualSessionsPerConsultant,
        r.annualSessionsPerConsultant,
      ),
    ).toBe(true);

    // net - onCallBurden === residual
    expect(
      close(
        r.annualSessionsPerConsultant - r.annualOnCallBurdenPerConsultant,
        r.residualListCapacityPerConsultant,
      ),
    ).toBe(true);
  });

  it("applies sickness derating multiplicatively to net capacity", () => {
    const base = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      sicknessRatePct: 0,
    });
    const sick = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      sicknessRatePct: 10,
    });

    expect(base.sicknessFactor).toBe(1);
    expect(sick.sicknessFactor).toBeCloseTo(0.9, 10);
    // 10% derating → 90% of base capacity
    expect(sick.annualSessionsPerConsultant).toBeCloseTo(
      base.annualSessionsPerConsultant * 0.9,
      6,
    );
    // 0% sickness → no sickness loss
    expect(base.sicknessLostAnnualSessionsPerConsultant).toBe(0);
  });

  it("converts on-call PAs into annual session-equivalents on the demand side", () => {
    const inp: FeasibilityInputs = {
      ...FEASIBILITY_DEFAULTS,
      theatreOnCallPAsPerWeek: 2,
      icuOnCallPAsPerWeek: 2,
      sessionsPerPa: 1,
      weeksPerYear: 52,
    };
    const r = calculateFeasibility(inp);
    expect(r.weeklyOnCallPAs).toBe(4);
    expect(r.annualOnCallSessionEquiv).toBe(4 * 1 * 52); // 208
  });

  it("on-call burden per consultant scales with the on-call demand", () => {
    const noOnCall = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      theatreOnCallPAsPerWeek: 0,
      icuOnCallPAsPerWeek: 0,
    });
    const withOnCall = calculateFeasibility(FEASIBILITY_DEFAULTS);

    expect(noOnCall.annualOnCallBurdenPerConsultant).toBe(0);
    expect(withOnCall.annualOnCallBurdenPerConsultant).toBeGreaterThan(0);
    // Residual must be strictly smaller when on-call is added
    expect(withOnCall.residualListCapacityPerConsultant).toBeLessThan(
      withOnCall.annualSessionsPerConsultant,
    );
  });

  it("on-call burden per consultant equals total on-call demand / FTE", () => {
    const r = calculateFeasibility(FEASIBILITY_DEFAULTS);
    expect(r.annualOnCallBurdenPerConsultant).toBeCloseTo(
      r.annualOnCallSessionEquiv / r.fteNeeded,
      6,
    );
  });

  it("FTE × per-consultant capacity covers total annual demand", () => {
    const r = calculateFeasibility(FEASIBILITY_DEFAULTS);
    expect(r.fteNeeded * r.annualSessionsPerConsultant).toBeCloseTo(
      r.annualDemand,
      4,
    );
  });

  it("ICU subgroup: residual = net per-consultant capacity − ICU demand share", () => {
    const r = calculateFeasibility(FEASIBILITY_DEFAULTS);
    expect(r.icuDemandPerConsultant).toBeCloseTo(
      r.icuAnnualDemand / FEASIBILITY_DEFAULTS.icuTrainedPoolSize,
      6,
    );
    expect(r.icuResidualCapacityPerConsultant).toBeCloseTo(
      r.annualSessionsPerConsultant - r.icuDemandPerConsultant,
      6,
    );
  });

  it("ICU pool capacity reflects sickness derating", () => {
    const noSick = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      sicknessRatePct: 0,
    });
    const sick = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      sicknessRatePct: 20,
    });
    expect(sick.icuPoolAnnualCapacity).toBeCloseTo(
      noSick.icuPoolAnnualCapacity * 0.8,
      6,
    );
    // Same demand, smaller capacity → higher utilisation
    expect(sick.icuPoolUtilisation).toBeGreaterThan(noSick.icuPoolUtilisation);
  });

  it("handles zero per-consultant capacity without NaN", () => {
    const r = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      dccPasPerConsultant: 0,
    });
    expect(r.annualSessionsPerConsultant).toBe(0);
    expect(r.fteNeeded).toBe(Infinity);
    // Guard: burden falls back to 0 when FTE isn't finite
    expect(r.annualOnCallBurdenPerConsultant).toBe(0);
    expect(r.icuPoolUtilisation).toBe(Infinity);
  });

  it("handles empty ICU pool without divide-by-zero", () => {
    const r = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      icuTrainedPoolSize: 0,
    });
    expect(r.icuPoolAnnualCapacity).toBe(0);
    expect(r.icuPoolUtilisation).toBe(Infinity);
    expect(r.icuDemandPerConsultant).toBe(0);
    expect(r.icuSharePerConsultant).toBe(Infinity);
  });

  it("known-value spot check on defaults", () => {
    const r = calculateFeasibility(FEASIBILITY_DEFAULTS);
    // 13 theatres × 10 sess/wk = 130
    expect(r.theatreSessions).toBe(130);
    // + 10 LW + 10 CIC + 5 pain + 5 POAC + 10 ICU = 170
    expect(r.weeklySessionDemand).toBe(170);
    // leave = (32+7+8)/5 = 9.4 wks
    expect(r.leaveWeeks).toBeCloseTo(9.4, 10);
    // working = 52 - 9.4 = 42.6
    expect(r.workingWeeks).toBeCloseTo(42.6, 10);
    // weekly clinical = 7.5 * 1 = 7.5
    expect(r.weeklyClinicalSessions).toBe(7.5);
    // net cap = 7.5 * 42.6 * 0.95 = 303.525
    expect(r.annualSessionsPerConsultant).toBeCloseTo(303.525, 6);
  });

  it("includes consultant-in-charge sessions in weekly demand", () => {
    const without = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      consultantInChargeSessionsPerWeek: 0,
    });
    const withCic = calculateFeasibility({
      ...FEASIBILITY_DEFAULTS,
      consultantInChargeSessionsPerWeek: 10,
    });
    expect(withCic.weeklySessionDemand - without.weeklySessionDemand).toBe(10);
    expect(withCic.fteNeeded).toBeGreaterThan(without.fteNeeded);
  });
});
