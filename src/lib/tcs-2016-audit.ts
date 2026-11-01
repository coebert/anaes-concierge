// 2016 Junior Doctor TCS — ESTIMATED WORKING-HOURS SCREENING (not a
// contractual compliance determination or legal certification).
//
// Shift timings are INFERRED from the half-day enum below, rota-cycle and
// mutual-agreement inputs are usually unknown, and coverage may be
// incomplete. This module therefore never returns a "compliant" verdict:
// the best outcome is "no flags (estimated)". A definitive check needs
// actual start/finish times, the full rota cycle and any recorded
// agreements (see the BMA rota checker / NHS Employers TCS).
//
// Inputs are pure data (rota assignments) so this is fully unit-testable.
// Session start/end times are approximated from the half-day enum:
//
//   am    08:00–13:00  (5h)
//   pm    13:00–18:00  (5h)
//   eve   18:00–21:00  (3h)
//   night 21:00–08:00 next day  (11h)
//
// Where a rule cannot be evaluated from the available data (e.g. true shift
// boundaries when start/end times are not stored), the rule is reported as
// "indeterminate" rather than passing silently.

export type Session = "am" | "pm" | "eve" | "night";

export type AuditAssignment = {
  session_date: string; // YYYY-MM-DD
  session: Session;
  duty_type: string;
  role_on_list: string;
};

export type RuleStatus = "pass" | "fail" | "warn" | "indeterminate";

export type ShiftSummary = {
  date: string; // session_date (night shifts: the day it starts)
  session: Session;
  /** All constituent half-day sessions merged into this shift (chronological). */
  sessions: Session[];
  hours: number;
  duty_type: string;
  isNight: boolean;
  isLong: boolean;
  isWeekend: boolean;
};

export type RuleEvidence = {
  /** Optional date-range the rule examined for its peak/worst result. */
  windowStart?: string;
  windowEnd?: string;
  /** The shifts that drove the rule's result (peak window, longest run, breaches). */
  shifts: ShiftSummary[];
  /** Free-form rows of structured detail — gap pairs, weekend pairs, etc. */
  notes?: string[];
};

export type RuleResult = {
  id: string;
  label: string;
  status: RuleStatus;
  detail: string;
  breaches?: Array<{ date: string; note: string }>;
  evidence?: RuleEvidence;
};

export type AuditOverall =
  /** At least one estimated rule flags a possible breach — verify with actual timings. */
  | "possible_breach"
  /** No rule flagged, but at least one required rule could not be assessed. */
  | "incomplete"
  /** Every assessed rule passed on estimated timings. Still NOT a compliance certification. */
  | "no_flags_estimated"
  | "insufficient_data";

export type AuditResult = {
  overall: AuditOverall;
  /** Always "estimated_screening": timings are inferred, not recorded. */
  basis: "estimated_screening";
  /** Plain-language reasons this result is not definitive. */
  caveats: string[];
  totalShifts: number;
  totalHours: number;
  /** First / last shift date actually present in the data (may be narrower than the requested window). */
  windowStart: string | null;
  windowEnd: string | null;
  /** The reference window the audit was *asked* to cover, before clamping to shift data. */
  requestedWindowStart: string | null;
  requestedWindowEnd: string | null;
  /** LTFT pro-rata fraction applied (1 = full-time, 0.8 = 4 days/wk, etc.). */
  ltftFraction: number;
  rules: RuleResult[];
  /** Every merged shift fed into the audit, in chronological order. */
  shifts: ShiftSummary[];
};

const SESSION_HOURS: Record<Session, number> = { am: 5, pm: 5, eve: 3, night: 11 };

// Local-time start/end offsets relative to session_date (in hours from midnight).
const SESSION_WINDOW: Record<Session, { startH: number; endH: number; crossesMidnight: boolean }> =
  {
    am: { startH: 8, endH: 13, crossesMidnight: false },
    pm: { startH: 13, endH: 18, crossesMidnight: false },
    eve: { startH: 18, endH: 21, crossesMidnight: false },
    night: { startH: 21, endH: 8, crossesMidnight: true },
  };

type Shift = {
  date: string; // session_date (for night shifts: the day it starts)
  startMs: number; // UTC ms of approximate start
  endMs: number;
  hours: number;
  session: Session;
  /** All half-day sessions merged into this shift (chronological). */
  sessions: Session[];
  duty_type: string;
  isNight: boolean;
  isLong: boolean; // >= 10h
  isWeekend: boolean; // Sat/Sun (start day)
};

function dateAtHour(dateISO: string, hour: number, addDays = 0): number {
  // Treat dates as UTC midnight so the math is straightforward and DST-free.
  const [y, m, d] = dateISO.split("-").map((n) => parseInt(n, 10));
  return Date.UTC(y, m - 1, d + addDays, hour, 0, 0);
}

function toShift(a: AuditAssignment): Shift {
  const w = SESSION_WINDOW[a.session];
  const hours = SESSION_HOURS[a.session];
  const startMs = dateAtHour(a.session_date, w.startH);
  const endMs = w.crossesMidnight
    ? dateAtHour(a.session_date, w.endH, 1)
    : dateAtHour(a.session_date, w.endH);
  const dayOfWeek = new Date(startMs).getUTCDay(); // 0=Sun..6=Sat
  return {
    date: a.session_date,
    startMs,
    endMs,
    hours,
    session: a.session,
    sessions: [a.session],
    duty_type: a.duty_type,
    isNight: a.session === "night",
    // TCS 2016: a "long shift" lasts MORE than 10 hours. A standard AM+PM
    // theatre day merges to exactly 10 h and must not be counted as long.
    isLong: hours > 10,
    // A shift counts toward a weekend if ANY part of it falls on Sat/Sun —
    // e.g. a Friday night running into Saturday morning.
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6 || isWeekendDow(new Date(endMs - 1).getUTCDay()),
  };
}

function isWeekendDow(d: number): boolean {
  return d === 0 || d === 6;
}

/** Saturday keys (YYYY-MM-DD) of every weekend a shift touches, incl. cross-midnight. */
function weekendKeysTouched(startMs: number, endMs: number): string[] {
  const keys = new Set<string>();
  for (
    let t = Date.UTC(
      new Date(startMs).getUTCFullYear(),
      new Date(startMs).getUTCMonth(),
      new Date(startMs).getUTCDate(),
    );
    t < endMs;
    t += 86_400_000
  ) {
    const dow = new Date(t).getUTCDay();
    if (dow === 6) keys.add(new Date(t).toISOString().slice(0, 10));
    else if (dow === 0) keys.add(new Date(t - 86_400_000).toISOString().slice(0, 10));
  }
  return [...keys];
}

// Merge adjacent sessions on the same calendar day into a single "shift"
// for per-shift length rules. Night sessions are always their own shift.
function mergeDaytimeShifts(shifts: Shift[]): Shift[] {
  const out: Shift[] = [];
  const byDate = new Map<string, Shift[]>();
  for (const s of shifts) {
    if (s.isNight) {
      out.push(s);
      continue;
    }
    const arr = byDate.get(s.date) ?? [];
    arr.push(s);
    byDate.set(s.date, arr);
  }
  for (const [date, arr] of byDate) {
    arr.sort((a, b) => a.startMs - b.startMs);
    const totalH = arr.reduce((s, x) => s + x.hours, 0);
    const merged: Shift = {
      date,
      startMs: arr[0].startMs,
      endMs: arr[arr.length - 1].endMs,
      hours: totalH,
      session: arr[0].session,
      sessions: arr.map((x) => x.session),
      duty_type: arr.map((x) => x.duty_type).join("+"),
      isNight: false,
      isLong: totalH > 10,
      isWeekend: arr.some((x) => x.isWeekend),
    };
    out.push(merged);
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

/**
 * Optional context that materially changes how the audit is computed.
 *
 *  - `windowStartISO` / `windowEndISO`: the reference period the audit was
 *    asked to cover (lookback clamped to the trainee's rotation). When
 *    supplied, R1 (average ≤ 48 h/week) divides by this period — not by
 *    the span between the first and last shift — so sparse data and
 *    leave blocks no longer artificially deflate the average.
 *  - `leaveDates`: set of `YYYY-MM-DD` strings the trainee was on approved
 *    leave. Leave days are (a) subtracted from R1's denominator (TCS 2016
 *    averaging excludes annual / study leave) and (b) treated as bridging
 *    days for R6 ("max 7 consecutive days") — leave doesn't count as a
 *    rostered day off, so a working stretch interrupted only by leave is
 *    still one continuous working period.
 */
export type AuditOptions = {
  windowStartISO?: string;
  windowEndISO?: string;
  leaveDates?: Set<string>;
  /**
   * Weekday numbers (0 = Sun … 6 = Sat) the trainee is contracted NOT to
   * work because they are Less Than Full Time. Used to (a) pro-rate the
   * 48 h/week R1 cap and (b) bridge consecutive-day runs (R6) across
   * non-working days, since an LTFT day off is not a rostered rest day
   * in the TCS-2016 sense.
   */
  ltftDaysOff?: number[];
  /**
   * TRUE only when a recorded, explicit mutual agreement allows up to 5
   * consecutive long shifts. Default (absent/false) is the contractual
   * maximum of 4. Never infer this.
   */
  agreedFiveLongShifts?: boolean;
  /**
   * Length of the full rota cycle in weeks, if known from the work
   * schedule. Weekend frequency is a whole-cycle measure, so without it
   * the weekend rule is reported "not assessed".
   */
  rotaCycleWeeks?: number;
};

const BASE_CAVEATS = [
  "Shift start/finish times are inferred (AM 08–13, PM 13–18, eve 18–21, night 21–08), not recorded.",
  "This is an estimated screening aid, not a contractual or legal compliance determination.",
];

/** Count of contracted weekdays per LTFT week (excluding weekends), capped at 5. */
function ltftWorkingWeekdays(ltftDaysOff: number[] | undefined): number {
  if (!ltftDaysOff || ltftDaysOff.length === 0) return 5;
  const off = new Set(ltftDaysOff.filter((d) => d >= 1 && d <= 5));
  return Math.max(0, 5 - off.size);
}

export function auditTcs2016(
  assignments: AuditAssignment[],
  options: AuditOptions = {},
): AuditResult {
  const leaveDates = options.leaveDates ?? new Set<string>();
  const ltftOffDows = new Set<number>(options.ltftDaysOff ?? []);
  const ltftFraction = ltftWorkingWeekdays(options.ltftDaysOff) / 5;
  // Only "working" duty assignments — exclude leave/admin/teaching markers
  // that are not actually working shifts. (role_on_list 'non_clinical',
  // 'teaching', 'admin_session' are still working hours under TCS, so we
  // include them; leave is not stored as a rota_assignment.)
  const working = assignments.filter((a) => a.session in SESSION_HOURS);
  if (working.length === 0) {
    return {
      overall: "insufficient_data",
      basis: "estimated_screening",
      caveats: [...BASE_CAVEATS, "No rota assignments were available to screen."],
      totalShifts: 0,
      totalHours: 0,
      windowStart: null,
      windowEnd: null,
      requestedWindowStart: options.windowStartISO ?? null,
      requestedWindowEnd: options.windowEndISO ?? null,
      ltftFraction,
      shifts: [],
      rules: [
        {
          id: "no_data",
          label: "Rota data available",
          status: "indeterminate",
          detail: "No rota assignments on record for this trainee.",
        },
      ],
    };
  }

  const rawShifts = working.map(toShift).sort((a, b) => a.startMs - b.startMs);
  const shifts = mergeDaytimeShifts(rawShifts);

  const windowStart = shifts[0].date;
  const windowEnd = shifts[shifts.length - 1].date;
  const totalHours = shifts.reduce((s, x) => s + x.hours, 0);

  const summarise = (s: Shift): ShiftSummary => ({
    date: s.date,
    session: s.session,
    sessions: s.sessions,
    hours: s.hours,
    duty_type: s.duty_type,
    isNight: s.isNight,
    isLong: s.isLong,
    isWeekend: s.isWeekend,
  });
  const shiftsByDate = new Map<string, Shift[]>();
  for (const s of shifts) {
    const arr = shiftsByDate.get(s.date) ?? [];
    arr.push(s);
    shiftsByDate.set(s.date, arr);
  }
  const shiftsInDayRange = (firstDate: string, lastDate: string): Shift[] => {
    const startMs = dateAtHour(firstDate, 0);
    const endMs = dateAtHour(lastDate, 0);
    return shifts.filter((s) => {
      const dMs = dateAtHour(s.date, 0);
      return dMs >= startMs && dMs <= endMs;
    });
  };
  const addDaysISO = (iso: string, n: number): string =>
    new Date(dateAtHour(iso, 0) + n * MS_DAY).toISOString().slice(0, 10);

  const rules: RuleResult[] = [];

  // R1 — Max 48h/week averaged over the rota's reference period.
  //
  // The reference period is the supplied audit window (lookback clamped to
  // rotation) when available, otherwise the span of recorded shifts. Days
  // the trainee was on approved leave are subtracted from the denominator
  // because TCS 2016 Schedule 3 paragraph 12 excludes annual / study /
  // sick leave from the WTD average.
  const refStartISO = options.windowStartISO ?? windowStart;
  const refEndISO = options.windowEndISO ?? windowEnd;
  const refSpanDaysRaw = Math.max(
    1,
    Math.round((dateAtHour(refEndISO, 0) - dateAtHour(refStartISO, 0)) / MS_DAY) + 1,
  );
  // Count only leave days that fall inside the reference period.
  let leaveInWindow = 0;
  for (const d of leaveDates) {
    if (d >= refStartISO && d <= refEndISO) leaveInWindow += 1;
  }
  const spanDays = Math.max(1, refSpanDaysRaw - leaveInWindow);
  const spanWeeks = spanDays / 7;
  const avgWeekly = totalHours / spanWeeks;
  const leaveNote =
    leaveInWindow > 0
      ? ` (excluded ${leaveInWindow} leave day${leaveInWindow === 1 ? "" : "s"})`
      : "";
  // The contractual average limit is 48 h/week. LTFT pro-rating of that
  // cap from an inferred FTE fraction is NOT a contractual rule, so it is
  // shown for information only and never drives the verdict.
  const ltftThreshold = 48;
  const ltftNote =
    ltftFraction < 1
      ? ` · LTFT ~${(ltftFraction * 100).toFixed(0)}% (pro-rata ${(48 * ltftFraction).toFixed(1)} h/wk shown for information only)`
      : "";
  rules.push({
    id: "avg_48h",
    label: "Average ≤ 48h / week (estimated, reference period up to 26 weeks)",
    status: spanWeeks < 4 ? "indeterminate" : avgWeekly <= ltftThreshold ? "pass" : "fail",
    detail:
      spanWeeks < 4
        ? `Only ${spanWeeks.toFixed(1)} weeks of data — need ≥4 weeks to average meaningfully (${totalHours} h logged)${ltftNote}`
        : `${avgWeekly.toFixed(1)} h/week averaged over ${spanWeeks.toFixed(1)} weeks (${totalHours} h / ${spanDays} working day${spanDays === 1 ? "" : "s"})${leaveNote}${ltftNote}`,
    evidence: {
      windowStart: refStartISO,
      windowEnd: refEndISO,
      shifts: shifts.map(summarise),
      notes: [
        `${shifts.length} shift(s) totalling ${totalHours} h across ${spanDays} contracted day(s) ≈ ${spanWeeks.toFixed(1)} weeks${leaveNote}${ltftNote}`,
      ],
    },
  });

  // R2 — Max 72h in any rolling 7 consecutive days
  let max72 = 0;
  let peak72Start = 0;
  const max72Breaches: Array<{ date: string; note: string }> = [];
  for (let i = 0; i < shifts.length; i++) {
    const windowEndMs = shifts[i].startMs + 7 * MS_DAY;
    let hSum = 0;
    for (let j = i; j < shifts.length && shifts[j].startMs < windowEndMs; j++) {
      hSum += shifts[j].hours;
    }
    if (hSum > max72) {
      max72 = hSum;
      peak72Start = i;
    }
    if (hSum > 72) {
      max72Breaches.push({
        date: shifts[i].date,
        note: `${hSum} h in 7-day window starting ${shifts[i].date}`,
      });
    }
  }
  const peak72WindowStart = shifts[peak72Start].date;
  const peak72WindowEnd = addDaysISO(peak72WindowStart, 6);
  rules.push({
    id: "max_72h_7d",
    label: "Max 72h in any 7 consecutive days",
    status: max72 <= 72 ? "pass" : "fail",
    detail: `Peak: ${max72} h in a rolling 7-day window`,
    breaches: max72Breaches.slice(0, 5),
    evidence: {
      windowStart: peak72WindowStart,
      windowEnd: peak72WindowEnd,
      shifts: shiftsInDayRange(peak72WindowStart, peak72WindowEnd).map(summarise),
      notes: [`Peak 7-day window: ${peak72WindowStart} → ${peak72WindowEnd} = ${max72} h`],
    },
  });

  // R3 — Max 13h per shift
  const long13 = shifts.filter((s) => s.hours > 13);
  rules.push({
    id: "max_13h_shift",
    label: "Max 13 hours per shift",
    status: long13.length === 0 ? "pass" : "fail",
    detail:
      long13.length === 0
        ? `All ${shifts.length} shifts ≤ 13 h`
        : `${long13.length} shift(s) exceed 13 h`,
    breaches: long13.slice(0, 5).map((s) => ({ date: s.date, note: `${s.hours} h shift` })),
    evidence:
      long13.length === 0
        ? undefined
        : {
            shifts: long13.map(summarise),
            notes: long13.map((s) => `${s.date} ${s.session}: ${s.hours} h`),
          },
  });

  // R4 — Max 5 consecutive long shifts (>10h)
  let runLong = 0;
  let maxRunLong = 0;
  let runStart = -1;
  let bestRunStart = -1;
  let bestRunEnd = -1;
  let lastLongIdx = -1;
  for (let k = 0; k < shifts.length; k++) {
    const s = shifts[k];
    if (!s.isLong) {
      runLong = 0;
      runStart = -1;
      lastLongIdx = -1;
      continue;
    }
    const dMs = dateAtHour(s.date, 0);
    const prevMs = lastLongIdx >= 0 ? dateAtHour(shifts[lastLongIdx].date, 0) : null;
    if (prevMs !== null && dMs - prevMs === MS_DAY) {
      runLong += 1;
    } else {
      runLong = 1;
      runStart = k;
    }
    if (runLong > maxRunLong) {
      maxRunLong = runLong;
      bestRunStart = runStart;
      bestRunEnd = k;
    }
    lastLongIdx = k;
  }
  const longRunRaw =
    bestRunStart >= 0 ? shifts.slice(bestRunStart, bestRunEnd + 1).filter((s) => s.isLong) : [];
  const longRunShifts = longRunRaw.map(summarise);
  // Cross-night evidence: flag night → next-day-long transitions inside the
  // run that also breach the 11 h rest rule. These shouldn't just read as
  // "two long shifts in a row" — they're also rest-gap breaches and the
  // user needs both pieces of context in one place.
  const crossNightNotes: string[] = [];
  for (let q = 1; q < longRunRaw.length; q++) {
    const prev = longRunRaw[q - 1];
    const cur = longRunRaw[q];
    if (!prev.isNight || cur.isNight) continue;
    const gapH = (cur.startMs - prev.endMs) / MS_HOUR;
    if (gapH < 11) {
      crossNightNotes.push(
        `Night ending ${prev.date} → long ${cur.date} ${cur.session}: only ${gapH.toFixed(1)} h rest (also breaches R7)`,
      );
    }
  }
  const longMax = options.agreedFiveLongShifts ? 5 : 4;
  rules.push({
    id: "max_consecutive_long",
    label: options.agreedFiveLongShifts
      ? "Max 5 consecutive long shifts (>10h) — recorded mutual agreement"
      : "Max 4 consecutive long shifts (>10h)",
    status: maxRunLong <= longMax ? "pass" : "fail",
    detail:
      `Longest run of consecutive long shifts (estimated lengths): ${maxRunLong}` +
      (options.agreedFiveLongShifts
        ? ""
        : " · limit is 4 unless an explicit mutual agreement for 5 is recorded"),
    evidence:
      longRunShifts.length === 0
        ? undefined
        : {
            windowStart: longRunShifts[0].date,
            windowEnd: longRunShifts[longRunShifts.length - 1].date,
            shifts: longRunShifts,
            notes: [
              `Longest unbroken run of >10 h shifts: ${maxRunLong} day(s)`,
              ...crossNightNotes,
            ],
          },
  });

  // R5 — Max 4 consecutive night shifts (consecutive calendar days)
  let runNight = 0;
  let maxRunNight = 0;
  let nightStart = -1;
  let bestNightStart = -1;
  let bestNightEnd = -1;
  let lastNightIdx = -1;
  for (let k = 0; k < shifts.length; k++) {
    const s = shifts[k];
    if (!s.isNight) continue;
    const dMs = dateAtHour(s.date, 0);
    const prevMs = lastNightIdx >= 0 ? dateAtHour(shifts[lastNightIdx].date, 0) : null;
    if (prevMs !== null && dMs - prevMs === MS_DAY) {
      runNight += 1;
    } else {
      runNight = 1;
      nightStart = k;
    }
    if (runNight > maxRunNight) {
      maxRunNight = runNight;
      bestNightStart = nightStart;
      bestNightEnd = k;
    }
    lastNightIdx = k;
  }
  const nightRunShifts =
    bestNightStart >= 0
      ? shifts
          .slice(bestNightStart, bestNightEnd + 1)
          .filter((s) => s.isNight)
          .map(summarise)
      : [];
  rules.push({
    id: "max_4_nights",
    label: "Max 4 consecutive night shifts",
    status: maxRunNight <= 4 ? "pass" : "fail",
    detail: `Longest run of nights: ${maxRunNight}`,
    evidence:
      nightRunShifts.length === 0
        ? undefined
        : {
            windowStart: nightRunShifts[0].date,
            windowEnd: nightRunShifts[nightRunShifts.length - 1].date,
            shifts: nightRunShifts,
            notes: [`Longest unbroken run of nights: ${maxRunNight} day(s)`],
          },
  });

  // R6 — Max 7 consecutive days worked. Leave days and contracted LTFT
  // non-working days both bridge a run: annual / study leave does not count
  // as a rostered day off under TCS, and an LTFT day off only counts as
  // rest if no working shift bookends it as part of a single stretch.
  const days = Array.from(new Set(shifts.map((s) => s.date))).sort();
  let runDays = 0;
  let maxRunDays = 0;
  let prevDay: number | null = null;
  let dayRunStart = 0;
  let bestDayStart = 0;
  let bestDayEnd = 0;
  const onlyBridgedBetween = (prevMs: number, curMs: number): boolean => {
    // Every calendar day strictly between prev and cur must be either a
    // leave day or an LTFT contracted day off.
    if (curMs - prevMs <= MS_DAY) return true;
    for (let t = prevMs + MS_DAY; t < curMs; t += MS_DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const dow = new Date(t).getUTCDay();
      if (!leaveDates.has(iso) && !ltftOffDows.has(dow)) return false;
    }
    return true;
  };
  for (let k = 0; k < days.length; k++) {
    const d = days[k];
    const dMs = dateAtHour(d, 0);
    if (prevDay !== null && (dMs - prevDay === MS_DAY || onlyBridgedBetween(prevDay, dMs))) {
      runDays += 1;
    } else {
      runDays = 1;
      dayRunStart = k;
    }
    if (runDays > maxRunDays) {
      maxRunDays = runDays;
      bestDayStart = dayRunStart;
      bestDayEnd = k;
    }
    prevDay = dMs;
  }

  const dayRunDates = days.slice(bestDayStart, bestDayEnd + 1);
  const dayRunShifts = dayRunDates.flatMap((d) => shiftsByDate.get(d) ?? []).map(summarise);
  rules.push({
    id: "max_7_consec_days",
    label: "Max 7 consecutive days worked",
    status: maxRunDays <= 7 ? "pass" : "fail",
    detail: `Longest run of consecutive working days: ${maxRunDays}`,
    evidence:
      dayRunDates.length === 0
        ? undefined
        : {
            windowStart: dayRunDates[0],
            windowEnd: dayRunDates[dayRunDates.length - 1],
            shifts: dayRunShifts,
            notes: [
              `${maxRunDays} consecutive working days: ${dayRunDates[0]} → ${dayRunDates[dayRunDates.length - 1]}`,
            ],
          },
  });

  // R7 — Minimum 11h rest between shifts
  const rest11Breaches: Array<{ date: string; note: string }> = [];
  const rest11Shifts: ShiftSummary[] = [];
  const rest11Notes: string[] = [];
  for (let i2 = 1; i2 < shifts.length; i2++) {
    const gapH = (shifts[i2].startMs - shifts[i2 - 1].endMs) / MS_HOUR;
    if (gapH < 11) {
      const note = `${gapH.toFixed(1)} h rest after previous shift on ${shifts[i2 - 1].date}`;
      rest11Breaches.push({ date: shifts[i2].date, note });
      rest11Shifts.push(summarise(shifts[i2 - 1]), summarise(shifts[i2]));
      rest11Notes.push(
        `${shifts[i2 - 1].date} ${shifts[i2 - 1].session} → ${shifts[i2].date} ${shifts[i2].session}: gap ${gapH.toFixed(1)} h`,
      );
    }
  }
  rules.push({
    id: "rest_11h",
    label: "Minimum 11h rest between shifts",
    status: rest11Breaches.length === 0 ? "pass" : "fail",
    detail:
      rest11Breaches.length === 0
        ? "No short-rest gaps detected"
        : `${rest11Breaches.length} gap(s) under 11 h`,
    breaches: rest11Breaches.slice(0, 5),
    evidence: rest11Shifts.length === 0 ? undefined : { shifts: rest11Shifts, notes: rest11Notes },
  });

  // R8 — Minimum 46h continuous rest after ANY run of night shifts.
  //
  // TCS 2016 Schedule 3 paragraph 13 mandates 46 h rest following any
  // period of consecutive night shifts (including a single night). The
  // previous implementation only fired for runs of ≥3 nights, which let
  // single- and double-night blocks slip through silently.
  const rest46Breaches: Array<{ date: string; note: string }> = [];
  const rest46Shifts: ShiftSummary[] = [];
  const rest46Notes: string[] = [];
  let i = 0;
  while (i < shifts.length) {
    if (shifts[i].isNight) {
      let j = i;
      while (j + 1 < shifts.length && shifts[j + 1].isNight) j++;
      const runLen = j - i + 1;
      if (j + 1 < shifts.length) {
        const gapH = (shifts[j + 1].startMs - shifts[j].endMs) / MS_HOUR;
        if (gapH < 46) {
          rest46Breaches.push({
            date: shifts[j].date,
            note: `Only ${gapH.toFixed(1)} h rest after ${runLen} consecutive night${runLen === 1 ? "" : "s"}`,
          });
          for (let k = i; k <= j + 1; k++) rest46Shifts.push(summarise(shifts[k]));
          rest46Notes.push(
            `${shifts[i].date} → ${shifts[j].date} (${runLen} night${runLen === 1 ? "" : "s"}), then ${shifts[j + 1].date} ${shifts[j + 1].session}: gap ${gapH.toFixed(1)} h`,
          );
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  rules.push({
    id: "rest_46h_post_nights",
    label: "Min 46h continuous rest after any night shift run",
    status: rest46Breaches.length === 0 ? "pass" : "fail",
    detail:
      rest46Breaches.length === 0
        ? "No short post-nights rest gaps detected"
        : `${rest46Breaches.length} gap(s) under 46 h after a night run`,
    breaches: rest46Breaches.slice(0, 5),
    evidence: rest46Shifts.length === 0 ? undefined : { shifts: rest46Shifts, notes: rest46Notes },
  });

  // R9 — Weekend frequency (max 1 in 2) is measured across the FULL rota
  // cycle. Shifts that cross into Saturday/Sunday count. Without a known
  // cycle length this is reported as not assessed rather than inferred
  // from back-to-back weekends (which is not the contractual test).
  const weekendsWorked = new Set<string>();
  for (const s of shifts)
    for (const k of weekendKeysTouched(s.startMs, s.endMs)) weekendsWorked.add(k);
  const sortedWE = Array.from(weekendsWorked).sort();
  const weekendShifts = shifts.filter((s) => s.isWeekend).map(summarise);
  const cycle = options.rotaCycleWeeks;
  const refWeeks = Math.max(1, Math.round(refSpanDaysRaw / 7));
  // Needs a known cycle AND a window covering at least one whole cycle.
  const cycleKnown =
    typeof cycle === "number" && Number.isInteger(cycle) && cycle > 0 && refWeeks >= cycle;
  const weekendFreq = weekendsWorked.size / refWeeks;
  rules.push({
    id: "weekend_freq",
    label: "Weekend frequency ≤ 1 in 2 (across the full rota cycle)",
    status: !cycleKnown ? "indeterminate" : weekendFreq <= 0.5 ? "pass" : "fail",
    detail: cycleKnown
      ? `${weekendsWorked.size} weekend(s) worked over ~${refWeeks} week(s) ≈ 1 in ${weekendFreq > 0 ? (1 / weekendFreq).toFixed(1) : "∞"} (rota cycle ${cycle} weeks)`
      : `${weekendsWorked.size} weekend(s) worked in window — not assessed: the full rota cycle is unknown or not fully covered`,
    evidence:
      weekendShifts.length === 0
        ? undefined
        : {
            shifts: weekendShifts,
            notes: [
              `Worked weekends (Sat keys, incl. shifts crossing into Sat/Sun): ${sortedWE.join(", ")}`,
            ],
          },
  });

  // (The former "max 8 days in any 14" rule was removed: it is not a 2016
  // TCS limit. The contractual limit is max 7 consecutive days — R6.)

  const hasFail = rules.some((r) => r.status === "fail");
  const hasIndeterminate = rules.some((r) => r.status === "indeterminate");
  const overall: AuditOverall = hasFail
    ? "possible_breach"
    : hasIndeterminate
      ? "incomplete"
      : "no_flags_estimated";
  const caveats = [...BASE_CAVEATS];
  if (!options.agreedFiveLongShifts)
    caveats.push(
      "No recorded agreement for 5 consecutive long shifts, so the default limit of 4 was applied.",
    );
  if (!cycleKnown) caveats.push("Rota cycle length unknown — weekend frequency not assessed.");
  for (const r of rules)
    if (r.status === "indeterminate") caveats.push(`Not assessed: ${r.label}.`);

  return {
    overall,
    basis: "estimated_screening",
    caveats,
    totalShifts: shifts.length,
    totalHours,
    windowStart,
    windowEnd,
    requestedWindowStart: options.windowStartISO ?? null,
    requestedWindowEnd: options.windowEndISO ?? null,
    ltftFraction,
    rules,
    shifts: shifts.map(summarise),
  };
}
