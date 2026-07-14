import { describe, it, expect } from "vitest";
import {
  commandPaletteFilter,
  normalizeForSearch,
  tokenizeQuery,
} from "./command-palette-filter";

// Mirrors how command-palette.tsx builds the CommandItem `value`:
// `${label} ${keywords.join(" ")} ${to}`.
const WELLBEING_VALUE =
  "Wellbeing & attrition wellbeing burnout attrition retention risk score /admin/wellbeing";
const LEAVE_FAIRNESS_VALUE =
  "Leave fairness leave fairness gini equity allocation annual leave /admin/leave-fairness";
const LEAVE_FORECAST_VALUE = "Leave forecast /leave/forecast";
const ABSENCE_VALUE =
  "Absence (Bradford) absence bradford sickness leave sick leave attendance /admin/absence";

describe("normalizeForSearch", () => {
  it("lowercases and strips punctuation/whitespace", () => {
    expect(normalizeForSearch("Well-Being & Attrition")).toBe("wellbeingattrition");
    expect(normalizeForSearch("  Leave   Fairness  ")).toBe("leavefairness");
  });
});

describe("tokenizeQuery", () => {
  it("splits on whitespace then strips punctuation per token", () => {
    expect(tokenizeQuery("well-being")).toEqual(["wellbeing"]);
    expect(tokenizeQuery("well being")).toEqual(["well", "being"]);
    expect(tokenizeQuery("  Leave   Fairness ")).toEqual(["leave", "fairness"]);
    expect(tokenizeQuery("")).toEqual([]);
  });
});

describe("commandPaletteFilter — Staff group variations", () => {
  it("matches 'leave fairness' → Leave fairness item", () => {
    expect(commandPaletteFilter(LEAVE_FAIRNESS_VALUE, "leave fairness")).toBe(1);
    expect(commandPaletteFilter(LEAVE_FAIRNESS_VALUE, "Leave  Fairness")).toBe(1);
  });

  it("keeps AND semantics — 'leave fairness' does NOT match Leave forecast", () => {
    expect(commandPaletteFilter(LEAVE_FORECAST_VALUE, "leave fairness")).toBe(0);
  });

  it("matches all three wellbeing variants → Wellbeing & attrition", () => {
    expect(commandPaletteFilter(WELLBEING_VALUE, "wellbeing")).toBe(1);
    expect(commandPaletteFilter(WELLBEING_VALUE, "well-being")).toBe(1);
    expect(commandPaletteFilter(WELLBEING_VALUE, "well being")).toBe(1);
    expect(commandPaletteFilter(WELLBEING_VALUE, "WELL BEING")).toBe(1);
  });

  it("matches partial-label queries against Absence (Bradford)", () => {
    expect(commandPaletteFilter(ABSENCE_VALUE, "bradford")).toBe(1);
    expect(commandPaletteFilter(ABSENCE_VALUE, "sick leave")).toBe(1);
  });

  it("returns 1 for empty query (cmdk shows everything)", () => {
    expect(commandPaletteFilter(WELLBEING_VALUE, "")).toBe(1);
    expect(commandPaletteFilter(WELLBEING_VALUE, "   ")).toBe(1);
  });

  it("returns 0 when a token is absent", () => {
    expect(commandPaletteFilter(WELLBEING_VALUE, "wellbeing rota")).toBe(0);
  });
});
