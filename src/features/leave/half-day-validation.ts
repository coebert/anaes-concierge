/**
 * Validation for the (start_date, end_date, half_day_start, half_day_end)
 * quad on a leave request.
 *
 * Semantics (mirrors `expandApprovedLeaveToAssignments`):
 *   - `half_day_start = "pm"` on the first day → skip AM (leave starts PM).
 *   - `half_day_end   = "am"` on the last  day → skip PM (leave ends at lunch).
 *   - Any other combination on those slots is semantically meaningless
 *     for the AM/PM grid and is rejected here so the DB never stores
 *     ambiguous markers (e.g. `half_day_start="am"`) that would silently
 *     be ignored downstream.
 *
 * "Reversed" single-day requests — the same date with
 * `half_day_start="pm"` AND `half_day_end="am"` — collapse to zero
 * half-sessions and are rejected.
 */

export type HalfDayMarker = "am" | "pm" | null;

export interface HalfDayRangeInput {
  start_date: string;
  end_date: string;
  half_day_start: HalfDayMarker;
  half_day_end: HalfDayMarker;
}

export type HalfDayValidationCode =
  | "missing_dates"
  | "reversed_dates"
  | "invalid_start_marker"
  | "invalid_end_marker"
  | "reversed_single_day";

export interface HalfDayValidationError {
  code: HalfDayValidationCode;
  message: string;
}

export type HalfDayValidationResult =
  | { ok: true; halfSessionCount: number }
  | { ok: false; errors: HalfDayValidationError[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysInclusive(startIso: string, endIso: string): number {
  const s = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  );
  const e = Date.UTC(
    Number(endIso.slice(0, 4)),
    Number(endIso.slice(5, 7)) - 1,
    Number(endIso.slice(8, 10)),
  );
  return Math.floor((e - s) / 86_400_000) + 1;
}

/**
 * Validate a leave-request half-session range.
 *
 * Returns `{ ok: true, halfSessionCount }` on success or
 * `{ ok: false, errors }` listing every failure. `halfSessionCount`
 * counts AM/PM slots covered — a single-day full-day request is 2,
 * a single half-day is 1, a multi-day request with both markers is
 * `2 * days - 2`.
 */
export function validateHalfDayRange(
  input: HalfDayRangeInput,
): HalfDayValidationResult {
  const errors: HalfDayValidationError[] = [];

  if (!ISO_DATE.test(input.start_date) || !ISO_DATE.test(input.end_date)) {
    errors.push({
      code: "missing_dates",
      message: "Start and end dates are required (YYYY-MM-DD).",
    });
    return { ok: false, errors };
  }

  if (input.end_date < input.start_date) {
    errors.push({
      code: "reversed_dates",
      message: "End date must be on or after start date.",
    });
  }

  if (input.half_day_start !== null && input.half_day_start !== "pm") {
    errors.push({
      code: "invalid_start_marker",
      message:
        'half_day_start must be "pm" (leave starts in the afternoon) or null.',
    });
  }
  if (input.half_day_end !== null && input.half_day_end !== "am") {
    errors.push({
      code: "invalid_end_marker",
      message:
        'half_day_end must be "am" (leave ends at lunchtime) or null.',
    });
  }

  if (
    errors.length === 0 &&
    input.start_date === input.end_date &&
    input.half_day_start === "pm" &&
    input.half_day_end === "am"
  ) {
    errors.push({
      code: "reversed_single_day",
      message:
        "Cannot combine an afternoon start and a morning end on the same day — that leaves no leave time.",
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const days = daysInclusive(input.start_date, input.end_date);
  let halves = days * 2;
  if (input.half_day_start === "pm") halves -= 1;
  if (input.half_day_end === "am") halves -= 1;
  return { ok: true, halfSessionCount: halves };
}
