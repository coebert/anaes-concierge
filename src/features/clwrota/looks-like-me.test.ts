import { describe, it, expect } from "vitest";
import { looksLikeMedicalExaminerLabel } from "./parsing";

describe("looksLikeMedicalExaminerLabel (sync validation of unmapped ME sessions)", () => {
  it("matches 'Medical Examiner' in any field, case-insensitively", () => {
    expect(looksLikeMedicalExaminerLabel(["Medical Examiner"])).toBe(true);
    expect(looksLikeMedicalExaminerLabel([null, "medical examiners"])).toBe(true);
    expect(looksLikeMedicalExaminerLabel([undefined, "MEDICAL EXAMINER session"])).toBe(true);
  });

  it("matches the short-form 'ME session' with a word boundary", () => {
    expect(looksLikeMedicalExaminerLabel(["ME session"])).toBe(true);
    expect(looksLikeMedicalExaminerLabel(["M.E. session"])).toBe(true);
    expect(looksLikeMedicalExaminerLabel([null, "SPA / ME sessions"])).toBe(true);
  });

  it("does not false-positive on 'me' inside unrelated words", () => {
    expect(looksLikeMedicalExaminerLabel(["Emergency theatre"])).toBe(false);
    expect(looksLikeMedicalExaminerLabel(["Anaesthesia trainee"])).toBe(false);
    expect(looksLikeMedicalExaminerLabel(["SPA"])).toBe(false);
    expect(looksLikeMedicalExaminerLabel([null, undefined, ""])).toBe(false);
  });
});
