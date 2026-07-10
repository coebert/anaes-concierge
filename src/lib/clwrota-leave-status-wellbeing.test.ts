import "@/test/assert-utc-hook";
/**
 * End-to-end regression test for the CLWRota → DB enum → wellbeing pipeline.
 *
 * The CLWRota upstream feed carries free-form status strings ("Approved.",
 * "Turned down", "en attente", "OK", "", null, garbage, emoji, non-English
 * synonyms). Those strings pass through `classifyLeaveStatus` on their way
 * into `leave_requests.status`, which is a Postgres enum with exactly four
 * values: `pending | approved | rejected | cancelled`.
 *
 * The wellbeing engine reads `leave_requests.status` directly and only
 * recognises those four enum values (rejected/cancelled contribute to the
 * "leave" driver; pending/approved are neutral). If the normaliser ever
 * emits anything else — a raw upstream string, `null`, `undefined`, a
 * legacy "denied" — the row would silently disappear from the wellbeing
 * score.
 *
 * This suite pins down two invariants across the whole pipeline:
 *
 *   1. `classifyLeaveStatus` is TOTAL over the DB enum: every output is
 *      one of the four permitted enum values, for every realistic raw
 *      input (approved/pending/rejected/cancelled synonyms across
 *      languages, negations, whitespace, punctuation, emoji, empty,
 *      null, undefined, and adversarial garbage).
 *
 *   2. Feeding the normalised statuses into `computeWellbeing` produces
 *      the same result as feeding hand-written enum literals — i.e. the
 *      wellbeing engine cannot tell whether a row came from CLWRota or
 *      an in-app booking. Rejected/cancelled synonyms contribute to the
 *      leave driver; approved/pending synonyms do not.
 */
import { describe, expect, it } from "vitest";

import { classifyLeaveStatus } from "@/lib/clwrota-leave-classify";
import {
  computeWellbeing,
  type LeaveLite,
} from "@/features/wellbeing/wellbeing-score";

const ENUM_VALUES = ["pending", "approved", "rejected", "cancelled"] as const;
type EnumStatus = (typeof ENUM_VALUES)[number];

const STAFF_ID = "staff-wellbeing-clwrota";
const NOW = new Date("2026-07-10T12:00:00Z");
const WINDOW_DAYS = 90;

// A representative slice of the raw strings CLWRota (and admin paste jobs
// on top of it) have been observed to emit. Each entry pins the expected
// canonical enum value the normaliser MUST land on.
const RAW_INPUTS: ReadonlyArray<{ raw: string | null | undefined; expected: EnumStatus }> = [
  // approved family
  { raw: "Approved", expected: "approved" },
  { raw: "  approved.  ", expected: "approved" },
  { raw: "APPROVED!!", expected: "approved" },
  { raw: "Granted", expected: "approved" },
  { raw: "Authorised", expected: "approved" },
  { raw: "Signed off", expected: "approved" },
  { raw: "OK", expected: "approved" },
  { raw: "approuvée", expected: "approved" },
  { raw: "genehmigt", expected: "approved" },
  { raw: "aprobado", expected: "approved" },
  { raw: "approvato", expected: "approved" },
  { raw: "zatwierdzony", expected: "approved" },
  { raw: "cymeradwywyd", expected: "approved" },

  // pending family
  { raw: "Pending", expected: "pending" },
  { raw: "Awaiting decision", expected: "pending" },
  { raw: "In review", expected: "pending" },
  { raw: "with HR", expected: "pending" },
  { raw: "on hold", expected: "pending" },
  { raw: "TBC", expected: "pending" },
  { raw: "en attente", expected: "pending" },
  { raw: "ausstehend", expected: "pending" },
  { raw: "pendiente", expected: "pending" },
  { raw: "in attesa", expected: "pending" },

  // rejected family (incl. negations that must beat "approved")
  { raw: "Rejected", expected: "rejected" },
  { raw: "Denied", expected: "rejected" },
  { raw: "Declined", expected: "rejected" },
  { raw: "Refused", expected: "rejected" },
  { raw: "not approved", expected: "rejected" },
  { raw: "not granted", expected: "rejected" },
  { raw: "turned down", expected: "rejected" },
  { raw: "refusée", expected: "rejected" },
  { raw: "abgelehnt", expected: "rejected" },
  { raw: "rechazado", expected: "rejected" },

  // cancelled family
  { raw: "Cancelled", expected: "cancelled" },
  { raw: "Withdrawn", expected: "cancelled" },
  { raw: "Revoked", expected: "cancelled" },
  { raw: "Rescinded", expected: "cancelled" },
  { raw: "called off", expected: "cancelled" },
  { raw: "annulée", expected: "cancelled" },
  { raw: "storniert", expected: "cancelled" },
  { raw: "cancelado", expected: "cancelled" },

  // Feed-blank / unknown → published-feed default is "approved".
  { raw: null, expected: "approved" },
  { raw: undefined, expected: "approved" },
  { raw: "", expected: "approved" },
  { raw: "   ", expected: "approved" },
  { raw: "qwerty", expected: "approved" },
  { raw: "🚀", expected: "approved" },
  { raw: "12345", expected: "approved" },
];

function makeRow(status: string, overrides: Partial<LeaveLite> = {}): LeaveLite {
  return {
    staff_id: STAFF_ID,
    status,
    type: "annual",
    start_date: "2026-06-01",
    end_date: "2026-06-05",
    ...overrides,
  };
}

function run(rows: LeaveLite[]) {
  return computeWellbeing({
    staffId: STAFF_ID,
    now: NOW,
    windowDays: WINDOW_DAYS,
    assignments: [],
    changes: [],
    leave: rows,
    exceptions: [],
  });
}

function leaveDriverValue(result: ReturnType<typeof run>) {
  const d = result.drivers.find((x) => x.key === "leave");
  expect(d, "wellbeing result is missing the 'leave' driver").toBeDefined();
  return d!.value;
}

describe("classifyLeaveStatus → DB enum totality", () => {
  it("emits only DB-enum values for every raw CLWRota input", () => {
    const enumSet = new Set<string>(ENUM_VALUES);
    for (const { raw } of RAW_INPUTS) {
      const out = classifyLeaveStatus(raw);
      expect(
        enumSet.has(out),
        `classifyLeaveStatus(${JSON.stringify(raw)}) produced "${out}" — not a leave_status enum value`,
      ).toBe(true);
    }
  });

  it.each(RAW_INPUTS)(
    "maps $raw → $expected",
    ({ raw, expected }) => {
      expect(classifyLeaveStatus(raw)).toBe(expected);
    },
  );

  it("never returns null / undefined / empty string", () => {
    for (const { raw } of RAW_INPUTS) {
      const out = classifyLeaveStatus(raw);
      expect(out).not.toBeNull();
      expect(out).not.toBeUndefined();
      expect(out).not.toBe("");
    }
  });
});

describe("CLWRota-normalised statuses → computeWellbeing (never sees unknown values)", () => {
  it("wellbeing sees only enum values after normalisation", () => {
    const enumSet = new Set<string>(ENUM_VALUES);
    const rows = RAW_INPUTS.map(({ raw }, i) =>
      makeRow(classifyLeaveStatus(raw), {
        start_date: `2026-06-${String((i % 27) + 1).padStart(2, "0")}`,
        end_date: `2026-06-${String((i % 27) + 1).padStart(2, "0")}`,
      }),
    );
    for (const r of rows) {
      expect(enumSet.has(r.status)).toBe(true);
    }
    // And computeWellbeing accepts the whole batch without error.
    const result = run(rows);
    expect(result.drivers.find((d) => d.key === "leave")).toBeDefined();
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it("rejected-family raw strings contribute to the leave driver (same as literal 'rejected')", () => {
    const rejectedRaw = RAW_INPUTS.filter((x) => x.expected === "rejected");
    for (const { raw } of rejectedRaw) {
      const normalised = classifyLeaveStatus(raw);
      const viaRaw = leaveDriverValue(run([makeRow(normalised)]));
      const viaLiteral = leaveDriverValue(run([makeRow("rejected")]));
      expect(
        viaRaw,
        `raw ${JSON.stringify(raw)} → "${normalised}" gave leave-driver value ${viaRaw}, expected ${viaLiteral}`,
      ).toBe(viaLiteral);
    }
  });

  it("cancelled-family raw strings contribute to the leave driver (same as literal 'cancelled')", () => {
    const cancelledRaw = RAW_INPUTS.filter((x) => x.expected === "cancelled");
    for (const { raw } of cancelledRaw) {
      const normalised = classifyLeaveStatus(raw);
      const viaRaw = leaveDriverValue(run([makeRow(normalised)]));
      const viaLiteral = leaveDriverValue(run([makeRow("cancelled")]));
      expect(viaRaw).toBe(viaLiteral);
    }
  });

  it("approved-family and pending-family raw strings do NOT contribute to the leave driver", () => {
    const neutralRaw = RAW_INPUTS.filter(
      (x) => x.expected === "approved" || x.expected === "pending",
    );
    const baseline = leaveDriverValue(run([]));
    for (const { raw } of neutralRaw) {
      const normalised = classifyLeaveStatus(raw);
      const value = leaveDriverValue(run([makeRow(normalised)]));
      expect(
        value,
        `raw ${JSON.stringify(raw)} → "${normalised}" unexpectedly moved the leave driver (${value} vs baseline ${baseline})`,
      ).toBe(baseline);
    }
  });

  it("mixed batch of raw strings scores identically to the same batch expressed with enum literals", () => {
    const rawRows = RAW_INPUTS.map(({ raw }, i) =>
      makeRow(classifyLeaveStatus(raw), {
        start_date: `2026-06-${String((i % 27) + 1).padStart(2, "0")}`,
        end_date: `2026-06-${String((i % 27) + 1).padStart(2, "0")}`,
      }),
    );
    const literalRows = RAW_INPUTS.map(({ expected }, i) =>
      makeRow(expected, {
        start_date: `2026-06-${String((i % 27) + 1).padStart(2, "0")}`,
        end_date: `2026-06-${String((i % 27) + 1).padStart(2, "0")}`,
      }),
    );

    const rawResult = run(rawRows);
    const literalResult = run(literalRows);

    expect(rawResult.score).toBe(literalResult.score);
    expect(rawResult.band).toBe(literalResult.band);

    // Every driver must match one-for-one on key, value, normalised, weight.
    expect(rawResult.drivers.length).toBe(literalResult.drivers.length);
    for (const rawDriver of rawResult.drivers) {
      const litDriver = literalResult.drivers.find((d) => d.key === rawDriver.key);
      expect(litDriver, `missing driver ${rawDriver.key} in literal run`).toBeDefined();
      expect(rawDriver.value).toBe(litDriver!.value);
      expect(rawDriver.normalised).toBe(litDriver!.normalised);
      expect(rawDriver.weight).toBe(litDriver!.weight);
    }
  });

  it("legacy 'denied' raw string normalises to 'rejected' (not left as-is)", () => {
    // Guard against a regression where "denied" — the pre-fix spelling —
    // leaks into leave_requests.status and is silently ignored by the
    // wellbeing engine (which only recognises the four enum values).
    const normalised = classifyLeaveStatus("denied");
    expect(normalised).toBe("rejected");

    const viaRaw = leaveDriverValue(run([makeRow(normalised)]));
    const viaLiteral = leaveDriverValue(run([makeRow("rejected")]));
    expect(viaRaw).toBe(viaLiteral);
    expect(viaRaw).toBeGreaterThan(0);
  });
});
