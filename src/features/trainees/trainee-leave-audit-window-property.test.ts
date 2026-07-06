import { describe, it, expect } from "vitest";
import {
  computeLeaveWindow,
  leaveOverlapsWindow,
  isoDateOffsetUTC,
  LEAVE_LOOKAHEAD_DAYS,
} from "./trainee-leave-audit-window";

/**
 * Property-based fuzz tests for the 14-day leave-overlap window.
 *
 * Strategy:
 *   - Generate random `now` instants spanning a wide range (1970 → 2070),
 *     including times-near-DST-jumps and times-near-UTC-midnight, plus
 *     random leave intervals with both positive and zero/negative widths.
 *   - For each sample, compute the window + classification under the
 *     production implementation and under an independent reference
 *     implementation that uses Date.UTC arithmetic from scratch.
 *   - Assert the two agree, AND assert structural invariants that any
 *     correct overlap predicate must satisfy (symmetry of touch, exact
 *     14-day span, idempotence under +Nx24h on the `now` instant within
 *     the same UTC day, etc.).
 *
 * A seeded PRNG keeps failures reproducible: if a property fails, the
 * test output prints the seed + the offending sample so it can be
 * pinned as a deterministic regression.
 */

// -- Tiny seeded PRNG (mulberry32). Deterministic, no dep. ---------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng: () => number, lo: number, hi: number) =>
  Math.floor(rng() * (hi - lo + 1)) + lo;

// -- Reference implementations (independent of production code). ---------

/** UTC YYYY-MM-DD for an instant, computed via Date.UTC + getUTC*. */
function refUtcDate(instant: Date): string {
  const y = instant.getUTCFullYear();
  const m = instant.getUTCMonth();
  const d = instant.getUTCDate();
  const utcMidnight = new Date(Date.UTC(y, m, d));
  return utcMidnight.toISOString().slice(0, 10);
}

/** UTC YYYY-MM-DD `days` away from `instant`. */
function refOffset(instant: Date, days: number): string {
  const y = instant.getUTCFullYear();
  const m = instant.getUTCMonth();
  const d = instant.getUTCDate();
  const shifted = new Date(Date.UTC(y, m, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Independent overlap predicate over ISO date strings. */
function refOverlaps(
  leave: { start_date: string; end_date: string },
  window: { window_start: string; window_end: string },
): boolean {
  // Two closed intervals [a,b] and [c,d] overlap iff a<=d && c<=b. Using
  // ISO YYYY-MM-DD strings, lexicographic compare == calendar compare.
  return (
    leave.start_date <= window.window_end &&
    window.window_start <= leave.end_date
  );
}

// -- Sample generators ---------------------------------------------------

function randomInstant(rng: () => number): Date {
  // 1970-01-01 → ~2070-01-01. ±100 years comfortably covers every DST
  // rule change in the IANA db that could ever bite us, plus year-2038
  // (signed-32 epoch) and post-epoch oddities.
  const epoch = randInt(rng, 0, 3_155_760_000) * 1000 + randInt(rng, 0, 86_399_000);
  return new Date(epoch);
}

function randomLeaveAround(rng: () => number, anchor: Date): { start_date: string; end_date: string } {
  // Sample a leave interval whose start lies within ±60 days of the
  // anchor's UTC day, with width 0..30 days. This concentrates samples
  // around the boundary where overlap behaviour matters.
  const startOffset = randInt(rng, -60, 60);
  const width = randInt(rng, 0, 30);
  const start = refOffset(anchor, startOffset);
  const end = refOffset(anchor, startOffset + width);
  return { start_date: start, end_date: end };
}

// -- Properties ----------------------------------------------------------

const SEEDS = [1, 2, 3, 42, 1337, 0xdeadbeef, 0xc0ffee];

describe("property: window_start always equals reference UTC date of `now`", () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 500 random instants → window_start matches refUtcDate(now)`, () => {
      const rng = mulberry32(seed);
      for (let i = 0; i < 500; i++) {
        const now = randomInstant(rng);
        const w = computeLeaveWindow(now);
        const ref = refUtcDate(now);
        if (w.window_start !== ref) {
          throw new Error(
            `seed=${seed} i=${i} now=${now.toISOString()} ` +
              `prod=${w.window_start} ref=${ref}`,
          );
        }
        expect(w.window_start).toBe(ref);
      }
    });
  }
});

describe("property: window_end is exactly LEAVE_LOOKAHEAD_DAYS after window_start", () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 500 random instants → window_end = refOffset(now, 14)`, () => {
      const rng = mulberry32(seed);
      for (let i = 0; i < 500; i++) {
        const now = randomInstant(rng);
        const w = computeLeaveWindow(now);
        const expectedEnd = refOffset(now, LEAVE_LOOKAHEAD_DAYS);
        if (w.window_end !== expectedEnd) {
          throw new Error(
            `seed=${seed} i=${i} now=${now.toISOString()} ` +
              `prod=${w.window_end} ref=${expectedEnd}`,
          );
        }
        expect(w.window_end).toBe(expectedEnd);
      }
    });
  }
});

describe("property: isoDateOffsetUTC agrees with reference for arbitrary day offsets", () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 500 random (now, offset) samples agree`, () => {
      const rng = mulberry32(seed);
      for (let i = 0; i < 500; i++) {
        const now = randomInstant(rng);
        const offset = randInt(rng, -3650, 3650); // ±10 years
        const got = isoDateOffsetUTC(offset, now);
        const want = refOffset(now, offset);
        if (got !== want) {
          throw new Error(
            `seed=${seed} i=${i} now=${now.toISOString()} ` +
              `offset=${offset} prod=${got} ref=${want}`,
          );
        }
        expect(got).toBe(want);
      }
    });
  }
});

describe("property: leaveOverlapsWindow agrees with reference predicate", () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 2000 random (now, leave) pairs agree`, () => {
      const rng = mulberry32(seed);
      for (let i = 0; i < 2000; i++) {
        const now = randomInstant(rng);
        const window = computeLeaveWindow(now);
        const leave = randomLeaveAround(rng, now);
        const got = leaveOverlapsWindow(leave, window);
        const want = refOverlaps(leave, window);
        if (got !== want) {
          throw new Error(
            `seed=${seed} i=${i} now=${now.toISOString()} ` +
              `leave=${JSON.stringify(leave)} window=${JSON.stringify(window)} ` +
              `prod=${got} ref=${want}`,
          );
        }
        expect(got).toBe(want);
      }
    });
  }
});

describe("property: structural invariants of the overlap predicate", () => {
  it("any leave wholly before window_start does NOT overlap (1000 samples)", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const now = randomInstant(rng);
      const w = computeLeaveWindow(now);
      const gap = randInt(rng, 1, 365);
      const width = randInt(rng, 0, 30);
      const end = refOffset(now, -gap);
      const start = refOffset(now, -gap - width);
      expect(leaveOverlapsWindow({ start_date: start, end_date: end }, w)).toBe(false);
    }
  });

  it("any leave wholly after window_end does NOT overlap (1000 samples)", () => {
    const rng = mulberry32(100);
    for (let i = 0; i < 1000; i++) {
      const now = randomInstant(rng);
      const w = computeLeaveWindow(now);
      const gap = randInt(rng, 1, 365);
      const width = randInt(rng, 0, 30);
      const start = refOffset(now, LEAVE_LOOKAHEAD_DAYS + gap);
      const end = refOffset(now, LEAVE_LOOKAHEAD_DAYS + gap + width);
      expect(leaveOverlapsWindow({ start_date: start, end_date: end }, w)).toBe(false);
    }
  });

  it("any leave fully enclosing the window DOES overlap (1000 samples)", () => {
    const rng = mulberry32(101);
    for (let i = 0; i < 1000; i++) {
      const now = randomInstant(rng);
      const w = computeLeaveWindow(now);
      const before = randInt(rng, 0, 365);
      const after = randInt(rng, 0, 365);
      const start = refOffset(now, -before);
      const end = refOffset(now, LEAVE_LOOKAHEAD_DAYS + after);
      expect(leaveOverlapsWindow({ start_date: start, end_date: end }, w)).toBe(true);
    }
  });

  it("a leave that touches a window edge by a single day DOES overlap (1000 samples)", () => {
    const rng = mulberry32(102);
    for (let i = 0; i < 1000; i++) {
      const now = randomInstant(rng);
      const w = computeLeaveWindow(now);
      // touch at window_start
      expect(
        leaveOverlapsWindow(
          { start_date: refOffset(now, -10), end_date: w.window_start },
          w,
        ),
      ).toBe(true);
      // touch at window_end
      expect(
        leaveOverlapsWindow(
          { start_date: w.window_end, end_date: refOffset(now, LEAVE_LOOKAHEAD_DAYS + 10) },
          w,
        ),
      ).toBe(true);
    }
  });

  it("two instants on the same UTC day yield identical windows + identical classifications", () => {
    const rng = mulberry32(103);
    for (let i = 0; i < 500; i++) {
      const now = randomInstant(rng);
      // Snap to UTC midnight, then add a random number of ms < 1 day.
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      const d = now.getUTCDate();
      const midnight = new Date(Date.UTC(y, m, d));
      const a = new Date(midnight.getTime() + randInt(rng, 0, 86_399_999));
      const b = new Date(midnight.getTime() + randInt(rng, 0, 86_399_999));
      const wa = computeLeaveWindow(a);
      const wb = computeLeaveWindow(b);
      expect(wa).toEqual(wb);

      const leave = randomLeaveAround(rng, midnight);
      expect(leaveOverlapsWindow(leave, wa)).toBe(leaveOverlapsWindow(leave, wb));
    }
  });
});
