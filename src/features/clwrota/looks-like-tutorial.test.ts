import { describe, it, expect } from "vitest";
import { looksLikeTutorialLabel } from "./parsing";

describe("looksLikeTutorialLabel", () => {
  it("matches tutorial and tutorials tokens", () => {
    expect(looksLikeTutorialLabel(["Tutorial"])).toBe(true);
    expect(looksLikeTutorialLabel(["Consultant tutorials"])).toBe(true);
    expect(looksLikeTutorialLabel(["Tutorial/SPA"])).toBe(true);
  });

  it("matches lectures and departmental teaching", () => {
    expect(looksLikeTutorialLabel(["Lecture"])).toBe(true);
    expect(looksLikeTutorialLabel(["Departmental teaching"])).toBe(true);
  });

  it("does not match plain teaching blocks or College Tutor role", () => {
    expect(looksLikeTutorialLabel(["Teaching"])).toBe(false);
    expect(looksLikeTutorialLabel(["Non-patient-facing: Fellow"])).toBe(false);
    expect(looksLikeTutorialLabel(["College Tutor"])).toBe(false);
  });

  it("ignores nullish or empty labels", () => {
    expect(looksLikeTutorialLabel([null, undefined, ""])).toBe(false);
  });
});
