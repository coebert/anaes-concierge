import { describe, it, expect } from "vitest";
import { classifyLeaveOverlap } from "./trainee-leave-audit-classify";

// Seeded mulberry32 PRNG — same algorithm used in the window property tests.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[randInt(rng, 0, arr.length - 1)];
}

function randomLowercaseString(rng: () => number, minLen: number, maxLen: number) {
  const len = randInt(rng, minLen, maxLen);
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += chars[randInt(rng, 0, chars.length - 1)];
  }
  return s;
}

function randomMixedCase(rng: () => number, base: string) {
  let s = "";
  for (const ch of base) {
    if (rng() < 0.5) {
      s += ch.toUpperCase();
    } else {
      s += ch;
    }
  }
  return s;
}

const COUNTED_STATUSES = ["approved", "pending"] as const;
const IGNORED_STATUSES = ["cancelled", "denied", "reserve", "unknown"] as const;
const ALL_KNOWN_STATUSES = [...COUNTED_STATUSES, ...IGNORED_STATUSES] as const;

// Reference classifier that the property tests validate against.
// It mirrors the case-insensitive logic of classifyLeaveOverlap.
function refClassify(status: string): { counted: boolean; reason: string } {
  const s = status.toLowerCase();
  if (s === "approved") return { counted: true, reason: "approved" };
  if (s === "pending") return { counted: true, reason: "pending" };
  return { counted: false, reason: `other: ${s}` };
}

describe("classifyLeaveOverlap — property: exact known statuses", () => {
  const seeds = [42, 123, 999, 2024, 8675309];

  for (const seed of seeds) {
    it(`seed ${seed}: randomly drawn known statuses match reference`, () => {
      const rng = mulberry32(seed);
      const samples = 500;
      for (let i = 0; i < samples; i++) {
        const status = pick(rng, ALL_KNOWN_STATUSES);
        const actual = classifyLeaveOverlap(status);
        const expected = refClassify(status);
        expect(actual.counted).toBe(expected.counted);
      }
    });
  }
});

describe("classifyLeaveOverlap — property: mixed-case known statuses match reference", () => {
  const seeds = [42, 123, 999, 2024, 8675309];

  for (const seed of seeds) {
    it(`seed ${seed}: any mixed-case variant of known statuses matches reference`, () => {
      const rng = mulberry32(seed);
      const samples = 500;
      for (let i = 0; i < samples; i++) {
        const base = pick(rng, ALL_KNOWN_STATUSES);
        const mixed = randomMixedCase(rng, base);
        const actual = classifyLeaveOverlap(mixed);
        const expected = refClassify(mixed);
        expect(actual.counted).toBe(expected.counted);
      }
    });
  }
});

describe("classifyLeaveOverlap — property: arbitrary strings are ignored unless approved/pending", () => {
  const seeds = [42, 123, 999, 2024, 8675309];

  for (const seed of seeds) {
    it(`seed ${seed}: random arbitrary strings behave like reference`, () => {
      const rng = mulberry32(seed);
      const samples = 500;
      for (let i = 0; i < samples; i++) {
        const s = randomLowercaseString(rng, 1, 20);
        const actual = classifyLeaveOverlap(s);
        const expected = refClassify(s);
        expect(actual.counted).toBe(expected.counted);
      }
    });
  }
});

describe("classifyLeaveOverlap — property: structural invariants", () => {
  it("only 'approved' and 'pending' (any case) ever return counted = true", () => {
    const seeds = [1, 7, 13, 99, 256];
    for (const seed of seeds) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 200; i++) {
        const s = randomLowercaseString(rng, 1, 15);
        const result = classifyLeaveOverlap(s);
        if (result.counted) {
          const lowered = s.toLowerCase();
          expect(lowered === "approved" || lowered === "pending").toBe(true);
        }
      }
    }
  });

  it("case variants of 'approved' and 'pending' yield counted = true", () => {
    const variants = [
      "Approved", "APPROVED", "ApPrOvEd", "aPpRoVeD",
      "Pending", "PENDING", "PeNdInG", "pEnDiNg",
    ];
    for (const v of variants) {
      expect(classifyLeaveOverlap(v).counted).toBe(true);
    }
  });

  it("counted statuses always include the status name in their reason", () => {
    for (const s of COUNTED_STATUSES) {
      const reason = classifyLeaveOverlap(s).reason.toLowerCase();
      expect(reason).toContain(s);
    }
  });

  it("ignored known statuses always include the status name in their reason", () => {
    for (const s of IGNORED_STATUSES) {
      const reason = classifyLeaveOverlap(s).reason.toLowerCase();
      expect(reason).toContain(s);
    }
  });
});
