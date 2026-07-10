/**
 * Timezone-boundary coverage for the `decided_at` anchor in
 * `computeWellbeing`.
 *
 * The engine treats `decided_at` as an ISO 8601 string and anchors the
 * "when" via `decided_at.slice(0, 10)` — i.e. it uses the **wall-clock
 * calendar day encoded in the string itself**, not the UTC-normalised
 * day. The subsequent `inWin` check compares that day against the
 * window bounds using UTC midnight (`parseDay(iso)`).
 *
 * This behaviour is deliberate: rows are written to the DB with a
 * `decided_at` that already reflects the actor's local decision moment.
 * A rota coordinator in Sydney rejecting leave at 22:00 local (UTC+11)
 * on 2026-05-01 must be counted against 2026-05-01, not the UTC-shifted
 * 2026-04-30. Equally, a rejection at 22:00 in Honolulu (UTC-10) on
 * 2026-05-01 must count against 2026-05-01, not the UTC-shifted
 * 2026-05-02.
 *
 * These tests pin the string-slice semantics at the boundaries most
 * likely to regress:
 *
 *   1. Zone-suffixed ISO strings across day flips (Z, +HH:MM, -HH:MM,
 *      +14:00 extreme, +05:30 half-hour zone).
 *   2. Midnight/end-of-day pairs on either side of the window bounds.
 *   3. Fractional-second precision (e.g. `.999Z`).
 *   4. Non-UTC offsets that would flip the UTC day but must not flip
 *      the counted day (and vice versa).
 *
 * Sister coverage:
 *   - `wellbeing-score-decided-at-anchor.test.ts` — anchor selection
 *     (decided_at vs start_date, null fallback, precedence).
 *   - `wellbeing-decided-at-refresh.integration.test.tsx` — end-to-end
 *     from cancel/reject mutation to rendered score.
 */
import { describe, expect, it } from "vitest";

import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

const STAFF_ID = "staff-1";
// Window: `now.getTime() - 90 * DAY_MS` .. `now.getTime()`.
// With NOW = 2026-07-10T12:00:00Z, windowStartMs corresponds to
// 2026-04-11T12:00:00Z, and `parseDay(iso)` uses `${iso}T00:00:00Z`.
// So the smallest yyyy-mm-dd that lies inside the window is
// 2026-04-12 (00:00Z = 2026-04-12T00:00:00Z ≥ windowStartMs).
// 2026-04-11 (00:00Z) is BEFORE windowStartMs — just outside.
// The largest inside is 2026-07-10 (00:00Z) — `now` is 12:00Z, so
// 00:00Z of the same day is inside.
const NOW = new Date("2026-07-10T12:00:00Z");
const WINDOW_DAYS = 90;

// Reference days chosen to sit either side of, or exactly on, the
// boundary implied above.
const OUTSIDE_JUST_BEFORE = "2026-04-11"; // one day BEFORE the first in-window day
const INSIDE_FIRST = "2026-04-12"; // first fully in-window day
const INSIDE_MID = "2026-05-01";
const INSIDE_LAST = "2026-07-10"; // = NOW's UTC day, still inside
const OUTSIDE_AFTER = "2026-07-11"; // one day AFTER NOW's UTC day

function makeRow(overrides: Partial<LeaveLite> = {}): LeaveLite {
  return {
    staff_id: STAFF_ID,
    // start_date is irrelevant when decided_at is set (anchor precedence
    // is covered by the sister test); park it far outside so any
    // regression that silently falls back is caught by a count of 0.
    start_date: "2000-01-01",
    end_date: "2000-01-01",
    status: "cancelled",
    type: "annual",
    ...overrides,
  };
}

function leaveCount(rows: LeaveLite[]): number {
  const res = computeWellbeing({
    staffId: STAFF_ID,
    now: NOW,
    windowDays: WINDOW_DAYS,
    assignments: [],
    changes: [],
    leave: rows,
    exceptions: [],
  });
  const d = res.drivers.find((x) => x.key === "leave");
  if (!d) throw new Error("leave driver missing");
  return d.value;
}

describe("computeWellbeing — decided_at across timezone/day boundaries", () => {
  describe("string-slice semantics (wall-clock day, not UTC-normalised day)", () => {
    it(
      "counts a positive-offset timestamp by its LOCAL wall-clock day, " +
        "even when the UTC-equivalent would land on the previous day",
      () => {
        // 00:30+11:00 on 2026-05-01 = 13:30Z on 2026-04-30 in UTC.
        // If the engine UTC-normalised before slicing, this would count
        // as 2026-04-30 (still in-window here — inert). Flip start_date
        // to something outside → the row must count because slice→
        // 2026-05-01 lies inside.
        expect(
          leaveCount([
            makeRow({ decided_at: `${INSIDE_MID}T00:30:00+11:00` }),
          ]),
        ).toBe(1);
      },
    );

    it(
      "counts a negative-offset timestamp by its LOCAL wall-clock day, " +
        "not by the UTC-shifted next day",
      () => {
        // 23:30-10:00 on 2026-07-10 = 09:30Z on 2026-07-11 in UTC.
        // 2026-07-10 is inside; 2026-07-11 is outside. Slice yields the
        // former, so the row MUST count.
        expect(
          leaveCount([
            makeRow({ decided_at: `${INSIDE_LAST}T23:30:00-10:00` }),
          ]),
        ).toBe(1);
      },
    );

    it(
      "handles the +14:00 extreme (Kiribati/Line Islands) via wall-clock slice",
      () => {
        // 01:00+14:00 on 2026-07-10 = previous day 11:00Z in UTC.
        // Wall-clock day 2026-07-10 → inside window → counts.
        expect(
          leaveCount([
            makeRow({ decided_at: `${INSIDE_LAST}T01:00:00+14:00` }),
          ]),
        ).toBe(1);
        // And a wall-clock day that has fallen OUT of the window must NOT
        // count, even if the UTC-equivalent would still be in-window.
        expect(
          leaveCount([
            makeRow({ decided_at: `${OUTSIDE_AFTER}T01:00:00+14:00` }),
          ]),
        ).toBe(0);
      },
    );

    it("respects half-hour offsets (e.g. IST +05:30) at the wall-clock day flip", () => {
      // 23:59:59+05:30 on 2026-05-01 is 18:29:59Z on 2026-05-01.
      // 00:00:00+05:30 on 2026-05-02 is 18:30:00Z on 2026-05-01.
      // Both are in-window; the point is the slice differs by day.
      expect(
        leaveCount([
          makeRow({ decided_at: `${INSIDE_MID}T23:59:59+05:30` }),
          makeRow({ decided_at: `2026-05-02T00:00:00+05:30` }),
        ]),
      ).toBe(2);
    });
  });

  describe("edge-of-day timestamps at the window bounds", () => {
    it("late-UTC on the LAST in-window day (23:59:59.999Z) still counts", () => {
      expect(
        leaveCount([
          makeRow({ decided_at: `${INSIDE_LAST}T23:59:59.999Z` }),
        ]),
      ).toBe(1);
    });

    it("early-UTC on the FIRST fully in-window day (00:00:00Z) counts", () => {
      expect(
        leaveCount([
          makeRow({ decided_at: `${INSIDE_FIRST}T00:00:00.000Z` }),
        ]),
      ).toBe(1);
    });

    it(
      "late-UTC on the day JUST BEFORE the window opens does NOT count " +
        "(slice yields the outside day, regardless of how close 23:59:59Z is to the boundary)",
      () => {
        expect(
          leaveCount([
            makeRow({ decided_at: `${OUTSIDE_JUST_BEFORE}T23:59:59.999Z` }),
          ]),
        ).toBe(0);
      },
    );

    it(
      "early-UTC on the day JUST AFTER NOW's UTC day does NOT count " +
        "(slice yields the outside day even for 00:00:00.000Z)",
      () => {
        expect(
          leaveCount([
            makeRow({ decided_at: `${OUTSIDE_AFTER}T00:00:00.000Z` }),
          ]),
        ).toBe(0);
      },
    );

    it(
      "an offset timestamp whose UTC-equivalent crosses the boundary " +
        "is still counted (or dropped) by its wall-clock day",
      () => {
        // Wall-clock day = INSIDE_FIRST (inside), but with offset -11:00
        // the UTC-equivalent is INSIDE_FIRST 11:00Z → still inside. The
        // more instructive case: wall-clock day = OUTSIDE_JUST_BEFORE
        // with offset -11:00 → UTC-equivalent lands inside the window,
        // but the slice yields the outside day → MUST NOT count.
        expect(
          leaveCount([
            makeRow({ decided_at: `${OUTSIDE_JUST_BEFORE}T23:00:00-11:00` }),
          ]),
        ).toBe(0);
        // Symmetric: wall-clock day inside, offset pushes UTC-equivalent
        // outside → MUST still count (the slice is what governs).
        expect(
          leaveCount([
            makeRow({ decided_at: `${INSIDE_LAST}T23:00:00-11:00` }),
          ]),
        ).toBe(1);
      },
    );
  });

  describe("fractional-second and precision variations don't perturb the slice", () => {
    it.each([
      `${INSIDE_MID}T12:34:56Z`,
      `${INSIDE_MID}T12:34:56.7Z`,
      `${INSIDE_MID}T12:34:56.789Z`,
      `${INSIDE_MID}T12:34:56.123456Z`,
      `${INSIDE_MID}T00:00:00+00:00`,
      // A bare date (no time part) — slice(0,10) still yields the day.
      INSIDE_MID,
    ])("timestamp %s slices to an in-window day and counts", (ts) => {
      expect(leaveCount([makeRow({ decided_at: ts })])).toBe(1);
    });
  });

  describe("mixed timezone rows sum correctly in a single call", () => {
    it(
      "counts rows independently by their wall-clock day — 3 in-window, 2 out — " +
        "no cross-row rounding or UTC-normalisation leakage",
      () => {
        const rows: LeaveLite[] = [
          // #1 — Sydney evening, wall-clock inside (UTC would fall on
          // the previous day — must not change the outcome).
          makeRow({ decided_at: `${INSIDE_MID}T23:30:00+11:00`, status: "rejected" }),
          // #2 — Honolulu evening, wall-clock inside (UTC would fall on
          // the next day — must not push the row out).
          makeRow({ decided_at: `${INSIDE_MID}T23:30:00-10:00`, status: "cancelled" }),
          // #3 — Late-UTC on NOW's day, inside.
          makeRow({ decided_at: `${INSIDE_LAST}T23:59:59.999Z`, status: "cancelled" }),
          // #4 — Just-before-window at UTC end of day, MUST drop.
          makeRow({ decided_at: `${OUTSIDE_JUST_BEFORE}T23:59:59.999Z`, status: "rejected" }),
          // #5 — Just-after-NOW at UTC start of day, MUST drop.
          makeRow({ decided_at: `${OUTSIDE_AFTER}T00:00:00Z`, status: "cancelled" }),
        ];
        expect(leaveCount(rows)).toBe(3);
      },
    );
  });
});
