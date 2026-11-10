import { describe, it, expect } from "vitest";
import {
  COVER_TEXT,
  RISK_TIGHT,
  classifyRisk,
  isSeniorTrainee,
  isSoloCapable,
  scenarioVerdict,
  worseRisk,
} from "./cover-rules";

describe("solo-capable grades", () => {
  it("consultants and exactly ST6, ST7, ST8 trainees are solo-capable", () => {
    expect(isSoloCapable("consultant", null)).toBe(true);
    for (const l of ["ST6", "ST7", "ST8", " st8 "]) expect(isSoloCapable("trainee", l)).toBe(true);
  });
  it("ST1–ST5, CT, ST9, unrecorded levels, SAS and unknown grades are not", () => {
    for (const l of ["ST5", "ST4", "CT2", "ST9", "ST 8", "ST8+", "", null])
      expect(isSoloCapable("trainee", l)).toBe(false);
    expect(isSoloCapable("sas", "ST8")).toBe(false);
    expect(isSoloCapable("unknown", null)).toBe(false);
    expect(isSeniorTrainee("ST8")).toBe(true);
  });
});

describe("risk classification with explicit SPA contingency", () => {
  it(`tight is 0–${RISK_TIGHT}, ok above`, () => {
    expect(RISK_TIGHT).toBe(1);
    expect(classifyRisk(0, 0)).toBe("tight");
    expect(classifyRisk(1, 3)).toBe("tight");
    expect(classifyRisk(2, 2)).toBe("ok");
  });
  it("SPA closes a gap → spa_required; doesn't → shortfall", () => {
    expect(classifyRisk(-1, 0)).toBe("spa_required");
    expect(classifyRisk(-2, -1)).toBe("shortfall");
  });
  it("worst half ordering: shortfall > SPA needed > tight > ok", () => {
    expect(worseRisk("tight", "spa_required")).toBe("spa_required");
    expect(worseRisk("shortfall", "spa_required")).toBe("shortfall");
    expect(worseRisk("ok", "tight")).toBe("tight");
  });
  it("shared wording names ST8 and the SPA contingency", () => {
    expect(COVER_TEXT.soloCapable).toMatch(/ST6\/ST7\/ST8/);
    expect(COVER_TEXT.spa).toMatch(/never part of headroom/);
  });
});

describe("simulator verdicts", () => {
  it("a half newly at shortfall → new_shortfall", () => {
    expect(scenarioVerdict({ am: "ok", pm: "ok" }, { am: "shortfall", pm: "ok" })).toBe("new_shortfall");
  });
  it("a half newly needing SPA is reported (previously missed)", () => {
    expect(scenarioVerdict({ am: "tight", pm: "ok" }, { am: "spa_required", pm: "ok" })).toBe(
      "new_spa_required",
    );
  });
  it("already at risk in baseline → already_at_risk", () => {
    expect(scenarioVerdict({ am: "spa_required", pm: "ok" }, { am: "spa_required", pm: "ok" })).toBe(
      "already_at_risk",
    );
  });
  it("tight / ok by the worst simulated half", () => {
    expect(scenarioVerdict({ am: "ok", pm: "ok" }, { am: "ok", pm: "tight" })).toBe("tight");
    expect(scenarioVerdict({ am: "ok", pm: "ok" }, { am: "ok", pm: "ok" })).toBe("ok");
  });
});
