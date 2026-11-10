import { describe, expect, it } from "vitest";
import { isNonWorkingRotaLabel } from "./clwrota-labels";

describe("isNonWorkingRotaLabel — off-site locations are working rows", () => {
  it("does not treat an off-site specialty as a day off", () => {
    expect(isNonWorkingRotaLabel(["Laser", "Off site"])).toBe(false);
    expect(isNonWorkingRotaLabel(["Off-site"])).toBe(false);
    expect(isNonWorkingRotaLabel(["Off/Site"])).toBe(false);
    expect(isNonWorkingRotaLabel(["Laser / Off site"])).toBe(false);
    expect(isNonWorkingRotaLabel(["OFF SITE lists"])).toBe(false);
  });

  it("still drops genuine day-off markers", () => {
    expect(isNonWorkingRotaLabel(["Off"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Off Day"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Day off"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Surgeon: Off"])).toBe(true);
  });

  it("still drops a row that is off-site AND explicitly a day off", () => {
    expect(isNonWorkingRotaLabel(["Off site", "Day off"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Off site - day off"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Off site", "Available"])).toBe(true);
  });

  it("keeps coordinator-configured extra tokens working", () => {
    expect(isNonWorkingRotaLabel(["Off site study leave"], ["study leave"])).toBe(true);
  });
});
