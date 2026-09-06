import { describe, expect, it } from "vitest";
import { parsePaCredit, splitPersonNames } from "@/features/clwrota/parsing";

describe("parsePaCredit", () => {
  it("reads numeric and numeric-text PA fields", () => {
    expect(parsePaCredit({ pa: 1.5 })).toBe(1.5);
    expect(parsePaCredit({ pas: "2" })).toBe(2);
    expect(parsePaCredit({ pa_value: "1 PA" })).toBe(1);
    expect(parsePaCredit({ session: { pas: "0.5" } })).toBe(0.5);
  });

  it("returns null when no PA field is present or parseable", () => {
    expect(parsePaCredit({})).toBeNull();
    expect(parsePaCredit({ pa: "n/a" })).toBeNull();
    expect(parsePaCredit({ pa: 0 })).toBeNull();
    expect(parsePaCredit({ pa: -1 })).toBeNull();
  });
});

describe("splitPersonNames", () => {
  it("splits multi-consultant slot text", () => {
    expect(splitPersonNames("Dr Hogan & Dr Coe")).toEqual(["Dr Hogan", "Dr Coe"]);
    expect(splitPersonNames("Hogan, Coe")).toEqual(["Hogan", "Coe"]);
    expect(splitPersonNames("Hogan with Coe")).toEqual(["Hogan", "Coe"]);
    expect(splitPersonNames("Hogan / Coe + Bloggs")).toEqual(["Hogan", "Coe", "Bloggs"]);
  });

  it("returns a single fragment for one name", () => {
    expect(splitPersonNames("Dr Hogan")).toEqual(["Dr Hogan"]);
  });
});
