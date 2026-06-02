import { describe, expect, it } from "vitest";
import {
  diagnoseValidationCell,
  diagnoseValidationReport,
} from "./list-feasibility-diagnosis";
import type {
  ValidationCell,
  ValidationReport,
  ValidationSample,
} from "./list-feasibility-validation";

function sample(
  date: string,
  classification: ValidationSample["classification"],
  dutyType: string | null = null,
  notes: string | null = null,
): ValidationSample {
  return { date, classification, dutyType, roleOnList: null, notes };
}

function cell(overrides: Partial<ValidationCell>): ValidationCell {
  return {
    dow: 1,
    session: "am",
    modelPct: 50,
    modelRegular: true,
    modelRegularDayOff: false,
    tenureDates: 20,
    sampleSize: 10,
    clinical: 0,
    offDayLabel: 0,
    otherDuty: 0,
    noRecord: 0,
    sampledPct: 0,
    delta: 0,
    mismatch: true,
    samples: [],
    ...overrides,
  };
}

describe("diagnoseValidationCell", () => {
  it("returns no diagnoses for non-mismatch cells", () => {
    expect(diagnoseValidationCell(cell({ mismatch: false }))).toEqual([]);
  });

  it("flags unrecognised off-day labels in other_duty rows", () => {
    const c = cell({
      modelPct: 80,
      sampledPct: 30,
      delta: -50,
      clinical: 3,
      otherDuty: 7,
      samples: [
        sample("2025-01-06", "other_duty", "admin", "Study leave"),
        sample("2025-01-13", "other_duty", "admin", "Annual leave"),
      ],
    });
    const d = diagnoseValidationCell(c);
    expect(d.some((x) => x.code === "unrecognised_off_label")).toBe(true);
  });

  it("flags clinical-looking labels stuck on non-theatre duty types", () => {
    const c = cell({
      modelPct: 20,
      sampledPct: 80,
      delta: 60,
      clinical: 2,
      otherDuty: 8,
      samples: [
        sample("2025-01-06", "other_duty", "obstetrics", "Obstetric list"),
        sample("2025-01-13", "other_duty", "endoscopy", "Endoscopy session"),
      ],
    });
    const d = diagnoseValidationCell(c);
    expect(d.some((x) => x.code === "non_theatre_clinical_label")).toBe(true);
    expect(
      d.find((x) => x.code === "non_theatre_clinical_label")?.remediation.href,
    ).toBe("/admin/duty-mappings");
  });

  it("flags off-day cells that nevertheless show clinical activity", () => {
    const c = cell({
      modelPct: 0,
      modelRegularDayOff: true,
      sampledPct: 60,
      delta: 60,
      clinical: 6,
      samples: [sample("2025-01-06", "clinical", "theatre")],
    });
    const d = diagnoseValidationCell(c);
    expect(d[0].code).toBe("off_day_with_clinical_activity");
    expect(d[0].severity).toBe("error");
  });

  it("flags sparse data when usable sample is tiny", () => {
    const c = cell({
      sampleSize: 3,
      offDayLabel: 0,
      noRecord: 3,
      delta: 40,
    });
    expect(
      diagnoseValidationCell(c).some((x) => x.code === "sparse_data"),
    ).toBe(true);
  });
});

describe("diagnoseValidationReport", () => {
  it("tallies causes across consultants and picks a top diagnosis", () => {
    const report: ValidationReport = {
      generatedAt: "2025-06-01",
      windowStart: "2024-12-01",
      windowEnd: "2025-06-01",
      monthsBack: 6,
      sampleCap: 10,
      mismatchThresholdPct: 15,
      totalCells: 1,
      cellsWithMismatch: 1,
      consultantsWithMismatch: 1,
      consultants: [
        {
          id: "c1",
          name: "Dr Test",
          tenureStart: "2024-12-01",
          tenureEnd: "2025-06-01",
          maxAbsDelta: 60,
          mismatchCount: 1,
          cells: [
            cell({
              modelRegularDayOff: true,
              clinical: 5,
              delta: 60,
              samples: [sample("2025-01-06", "clinical", "theatre")],
            }),
          ],
        },
      ],
    };
    const d = diagnoseValidationReport(report);
    expect(d.causeTally.length).toBeGreaterThan(0);
    expect(d.consultants[0].topDiagnosis?.code).toBe(
      "off_day_with_clinical_activity",
    );
    expect(d.consultants[0].cells[0].diagnoses.length).toBeGreaterThan(0);
  });
});
