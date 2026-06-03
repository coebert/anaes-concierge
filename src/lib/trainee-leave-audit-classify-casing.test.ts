import { describe, it, expect } from "vitest";
import { classifyLeaveOverlap } from "./trainee-leave-audit-classify";

/**
 * Exhaustive casing tests for every CLWRota leave status.
 * Every known status must map to the correct internal classification
 * regardless of how it is cased.
 */

const CASES = {
  approved: {
    lower: "approved",
    upper: "APPROVED",
    title: "Approved",
    mixed1: "ApPrOvEd",
    mixed2: "aPpRoVeD",
    expected: { counted: true, name: "approved" },
  },
  pending: {
    lower: "pending",
    upper: "PENDING",
    title: "Pending",
    mixed1: "PeNdInG",
    mixed2: "pEnDiNg",
    expected: { counted: true, name: "pending" },
  },
  cancelled: {
    lower: "cancelled",
    upper: "CANCELLED",
    title: "Cancelled",
    mixed1: "CaNcElLeD",
    mixed2: "cAnCeLlEd",
    expected: { counted: false, name: "cancelled" },
  },
  denied: {
    lower: "denied",
    upper: "DENIED",
    title: "Denied",
    mixed1: "DeNiEd",
    mixed2: "dEnIeD",
    expected: { counted: false, name: "denied" },
  },
  reserve: {
    lower: "reserve",
    upper: "RESERVE",
    title: "Reserve",
    mixed1: "ReSeRvE",
    mixed2: "rEsErVe",
    expected: { counted: false, name: "reserve" },
  },
  unknown: {
    lower: "unknown",
    upper: "UNKNOWN",
    title: "Unknown",
    mixed1: "UnKnOwN",
    mixed2: "uNkNoWn",
    expected: { counted: false, name: "unknown" },
  },
};

function check(
  label: string,
  status: string,
  expectedCounted: boolean,
  expectedName: string,
) {
  const r = classifyLeaveOverlap(status);
  expect(r.counted).toBe(expectedCounted);
  expect(r.reason.toLowerCase()).toContain(expectedName);
}

for (const [statusKey, variants] of Object.entries(CASES)) {
  describe(`classifyLeaveOverlap — ${statusKey} (all casings)`, () => {
    it(`lowercase "${variants.lower}"`, () => {
      check("lower", variants.lower, variants.expected.counted, variants.expected.name);
    });
    it(`uppercase "${variants.upper}"`, () => {
      check("upper", variants.upper, variants.expected.counted, variants.expected.name);
    });
    it(`title case "${variants.title}"`, () => {
      check("title", variants.title, variants.expected.counted, variants.expected.name);
    });
    it(`mixed case "${variants.mixed1}"`, () => {
      check("mixed1", variants.mixed1, variants.expected.counted, variants.expected.name);
    });
    it(`mixed case "${variants.mixed2}"`, () => {
      check("mixed2", variants.mixed2, variants.expected.counted, variants.expected.name);
    });
  });
}

describe("classifyLeaveOverlap — casing consistency across all statuses", () => {
  it("every counted status variant returns true", () => {
    const countedVariants = [
      ...Object.values(CASES.approved).filter((v): v is string => typeof v === "string"),
      ...Object.values(CASES.pending).filter((v): v is string => typeof v === "string"),
    ];
    for (const v of countedVariants) {
      expect(classifyLeaveOverlap(v).counted).toBe(true);
    }
  });

  it("every ignored status variant returns false", () => {
    const ignoredVariants = [
      ...Object.values(CASES.cancelled).filter((v): v is string => typeof v === "string"),
      ...Object.values(CASES.denied).filter((v): v is string => typeof v === "string"),
      ...Object.values(CASES.reserve).filter((v): v is string => typeof v === "string"),
      ...Object.values(CASES.unknown).filter((v): v is string => typeof v === "string"),
    ];
    for (const v of ignoredVariants) {
      expect(classifyLeaveOverlap(v).counted).toBe(false);
    }
  });
});
