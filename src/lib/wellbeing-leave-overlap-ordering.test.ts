import "@/test/assert-utc-hook";
/**
 * Regression tests for the wellbeing "leave" driver under OVERLAPPING
 * rejected/cancelled leave windows in every possible ordering.
 *
 * Why this matters:
 *   The leave driver counts rows whose status is `rejected` or `cancelled`
 *   and whose anchor date (`decided_at` — else `start_date`) lands inside
 *   the 90-day window. Because the engine is a pure filter+count with a
 *   `harmNorm` cap at 3, three invariants must hold no matter what order
 *   the rows arrive in:
 *
 *     1. ORDER INVARIANCE — Shuffling the input array must not change
 *        `driver.value`, `driver.normalised`, `driver.weight`, or the
 *        composite score/band.
 *
 *     2. STATUS SYMMETRY — Swapping every `rejected` for `cancelled`
 *        (and vice versa) on an overlapping-window batch must yield an
 *        identical leave-driver result.
 *
 *     3. NORMALISATION CAP — Even when many overlapping rejected/cancelled
 *        windows collide on the same days, the driver's `normalised` value
 *        is capped at 1.0 (never > 1), and rows are counted individually
 *        (overlap does NOT dedupe — each row is its own bad-leave event).
 *
 * A regression that (for example) added an implicit "collapse overlapping
 * windows" step, or sorted rows before counting, would break at least one
 * of these invariants and be caught here.
 */
import { describe, expect, it } from "vitest";

import {
  computeWellbeing,
  type LeaveLite,
  type WellbeingResult,
} from "@/features/wellbeing/wellbeing-score";

const STAFF_ID = "staff-overlap";
const NOW = new Date("2026-07-10T12:00:00Z");
const WINDOW_DAYS = 90;

function row(
  status: "rejected" | "cancelled" | "pending" | "approved",
  start: string,
  end: string,
  decided_at: string | null = null,
): LeaveLite {
  return {
    staff_id: STAFF_ID,
    status,
    type: "annual",
    start_date: start,
    end_date: end,
    decided_at,
  };
}

function run(leave: LeaveLite[]): WellbeingResult {
  return computeWellbeing({
    staffId: STAFF_ID,
    now: NOW,
    windowDays: WINDOW_DAYS,
    assignments: [],
    changes: [],
    leave,
    exceptions: [],
  });
}

function leaveDriver(r: WellbeingResult) {
  const d = r.drivers.find((x) => x.key === "leave");
  expect(d, "wellbeing result missing 'leave' driver").toBeDefined();
  return d!;
}

// Deterministic permutation generator (no shared mutable state, no RNG).
function permutations<T>(arr: readonly T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

/**
 * Two overlapping rejected windows + two overlapping cancelled windows,
 * all anchored inside the 90-day window (NOW - 90d … NOW). Overlap on
 * calendar days is intentional — the engine counts rows, not day-unions.
 */
const OVERLAPPING_BATCH: readonly LeaveLite[] = [
  // Rejected: two windows that overlap 2026-06-05..2026-06-10
  row("rejected", "2026-06-01", "2026-06-08", "2026-06-02T09:00:00Z"),
  row("rejected", "2026-06-05", "2026-06-12", "2026-06-06T09:00:00Z"),
  // Cancelled: two windows that overlap 2026-06-15..2026-06-18
  row("cancelled", "2026-06-14", "2026-06-18", "2026-06-13T09:00:00Z"),
  row("cancelled", "2026-06-15", "2026-06-20", "2026-06-14T09:00:00Z"),
];

describe("wellbeing leave driver — overlapping rejected/cancelled windows", () => {
  it("counts one row per overlapping window (no dedupe of overlapping days)", () => {
    const d = leaveDriver(run([...OVERLAPPING_BATCH]));
    // 2 rejected + 2 cancelled = 4 bad-leave rows, capped at 3 → normalised = 1
    expect(d.value).toBe(4);
    expect(d.normalised).toBe(1);
    expect(d.weight).toBe(0.1);
  });

  it("is invariant under every ordering of the input array", () => {
    const baseline = run([...OVERLAPPING_BATCH]);
    const baselineDriver = leaveDriver(baseline);

    const perms = permutations(OVERLAPPING_BATCH);
    // 4! = 24 orderings — exhaustive.
    expect(perms.length).toBe(24);

    for (const perm of perms) {
      const r = run(perm);
      const d = leaveDriver(r);
      expect(d.value).toBe(baselineDriver.value);
      expect(d.normalised).toBe(baselineDriver.normalised);
      expect(d.weight).toBe(baselineDriver.weight);
      expect(r.score).toBe(baseline.score);
      expect(r.band).toBe(baseline.band);
    }
  });

  it("is symmetric under status swap (rejected ↔ cancelled)", () => {
    const swapped = OVERLAPPING_BATCH.map((l) => ({
      ...l,
      status: l.status === "rejected" ? ("cancelled" as const) : ("rejected" as const),
    }));
    const original = leaveDriver(run([...OVERLAPPING_BATCH]));
    const swappedDriver = leaveDriver(run(swapped));
    expect(swappedDriver.value).toBe(original.value);
    expect(swappedDriver.normalised).toBe(original.normalised);
    expect(swappedDriver.weight).toBe(original.weight);
  });

  it("caps normalised at 1.0 no matter how many overlapping rows collide on the same day", () => {
    // 10 rows all overlapping the same calendar span; still capped at 1.0.
    const many: LeaveLite[] = Array.from({ length: 10 }, (_, i) =>
      row(
        i % 2 === 0 ? "rejected" : "cancelled",
        "2026-06-01",
        "2026-06-05",
        `2026-06-0${(i % 5) + 1}T09:00:00Z`,
      ),
    );
    const d = leaveDriver(run(many));
    expect(d.value).toBe(10);
    expect(d.normalised).toBe(1);
    expect(d.normalised).toBeLessThanOrEqual(1);
  });

  it("interleaving pending/approved rows between overlapping bad rows does not change the driver", () => {
    const baseline = leaveDriver(run([...OVERLAPPING_BATCH]));

    // Insert neutral rows at every position, overlapping the same span.
    const withNoise: LeaveLite[] = [
      row("approved", "2026-06-02", "2026-06-09"),
      OVERLAPPING_BATCH[0],
      row("pending", "2026-06-04", "2026-06-11"),
      OVERLAPPING_BATCH[1],
      row("approved", "2026-06-15", "2026-06-19", "2026-06-14T09:00:00Z"),
      OVERLAPPING_BATCH[2],
      row("pending", "2026-06-16", "2026-06-21"),
      OVERLAPPING_BATCH[3],
      row("approved", "2026-06-01", "2026-06-30"),
    ];

    const d = leaveDriver(run(withNoise));
    expect(d.value).toBe(baseline.value);
    expect(d.normalised).toBe(baseline.normalised);
  });

  it("decided_at anchor still applies when overlapping rows are reordered", () => {
    // Two overlapping cancelled windows whose start_date sits OUTSIDE the
    // window, but whose decided_at falls INSIDE — both should count, and
    // the order they arrive in must not matter.
    const outsideStart = "2025-01-01"; // well before window
    const insideDecided1 = "2026-06-01T09:00:00Z";
    const insideDecided2 = "2026-06-02T09:00:00Z";

    const a = row("cancelled", outsideStart, "2025-01-05", insideDecided1);
    const b = row("cancelled", outsideStart, "2025-01-05", insideDecided2);
    const c = row("rejected", outsideStart, "2025-01-05", insideDecided1);

    for (const perm of permutations([a, b, c])) {
      const d = leaveDriver(run(perm));
      expect(d.value).toBe(3);
      expect(d.normalised).toBe(1); // 3/3 cap
    }
  });

  it("decided_at OUTSIDE the window drops overlapping rows regardless of ordering", () => {
    // Rows whose start_date falls INSIDE the window but decided_at is OUT
    // must be dropped — even if they overlap each other and are shuffled.
    const insideStart = "2026-06-01";
    const outsideDecided = "2025-01-01T09:00:00Z";

    const rows: LeaveLite[] = [
      row("cancelled", insideStart, "2026-06-05", outsideDecided),
      row("cancelled", insideStart, "2026-06-05", outsideDecided),
      row("rejected", insideStart, "2026-06-05", outsideDecided),
    ];

    for (const perm of permutations(rows)) {
      const d = leaveDriver(run(perm));
      expect(d.value).toBe(0);
      expect(d.normalised).toBe(0);
    }
  });

  it("mixed decided_at (some inside, some outside, overlapping days) — count is stable across orderings", () => {
    const rows: LeaveLite[] = [
      // in-window via decided_at
      row("cancelled", "2025-01-01", "2025-01-05", "2026-06-01T09:00:00Z"),
      // out-of-window via decided_at (dropped)
      row("cancelled", "2026-06-01", "2026-06-05", "2025-01-01T09:00:00Z"),
      // in-window via start_date fallback (decided_at null)
      row("rejected", "2026-06-03", "2026-06-07", null),
      // out-of-window via start_date fallback (dropped)
      row("rejected", "2025-01-01", "2025-01-05", null),
    ];

    // Expected: 2 counted (rows 0 and 2), 2 dropped.
    for (const perm of permutations(rows)) {
      const d = leaveDriver(run(perm));
      expect(d.value).toBe(2);
      expect(d.normalised).toBeCloseTo(2 / 3, 10);
    }
  });

  it("composite score is bitwise-stable across all 24 permutations of the overlapping batch", () => {
    const scores = new Set<number>();
    const normalisedValues = new Set<number>();
    for (const perm of permutations(OVERLAPPING_BATCH)) {
      const r = run(perm);
      scores.add(r.score);
      normalisedValues.add(leaveDriver(r).normalised);
    }
    expect(scores.size).toBe(1);
    expect(normalisedValues.size).toBe(1);
  });
});
