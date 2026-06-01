// 2016 Junior Doctor Terms & Conditions of Service (TCS) compliance audit.
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
  date: string;          // session_date (night shifts: the day it starts)
  session: Session;
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

export type AuditResult = {
  overall: "compliant" | "non_compliant" | "insufficient_data";
  totalShifts: number;
  totalHours: number;
  windowStart: string | null;
  windowEnd: string | null;
  rules: RuleResult[];
  /** Every merged shift fed into the audit, in chronological order. */
  shifts: ShiftSummary[];
};

const SESSION_HOURS: Record<Session, number> = { am: 5, pm: 5, eve: 3, night: 11 };

// Local-time start/end offsets relative to session_date (in hours from midnight).
const SESSION_WINDOW: Record<Session, { startH: number; endH: number; crossesMidnight: boolean }> = {
  am:    { startH: 8,  endH: 13, crossesMidnight: false },
  pm:    { startH: 13, endH: 18, crossesMidnight: false },
  eve:   { startH: 18, endH: 21, crossesMidnight: false },
  night: { startH: 21, endH: 8,  crossesMidnight: true },
};

type Shift = {
  date: string;          // session_date (for night shifts: the day it starts)
  startMs: number;       // UTC ms of approximate start
  endMs: number;
  hours: number;
  session: Session;
  duty_type: string;
  isNight: boolean;
  isLong: boolean;       // >= 10h
  isWeekend: boolean;    // Sat/Sun (start day)
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
  const endMs = w.crossesMidnight ? dateAtHour(a.session_date, w.endH, 1) : dateAtHour(a.session_date, w.endH);
  const dayOfWeek = new Date(startMs).getUTCDay(); // 0=Sun..6=Sat
  return {
    date: a.session_date,
    startMs,
    endMs,
    hours,
    session: a.session,
    duty_type: a.duty_type,
    isNight: a.session === "night",
    // TCS 2016: a "long shift" lasts MORE than 10 hours. A standard AM+PM
    // theatre day merges to exactly 10 h and must not be counted as long.
    isLong: hours > 10,
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
  };
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
      duty_type: arr.map((x) => x.duty_type).join("+"),
      isNight: false,
      isLong: totalH > 10,
      isWeekend: arr[0].isWeekend,
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
};

export function auditTcs2016(
  assignments: AuditAssignment[],
  options: AuditOptions = {},
): AuditResult {
  const leaveDates = options.leaveDates ?? new Set<string>();
  // Only "working" duty assignments — exclude leave/admin/teaching markers
  // that are not actually working shifts. (role_on_list 'non_clinical',
  // 'teaching', 'admin_session' are still working hours under TCS, so we
  // include them; leave is not stored as a rota_assignment.)
  const working = assignments.filter((a) => a.session in SESSION_HOURS);
  if (working.length === 0) {
    return {
      overall: "insufficient_data",
      totalShifts: 0,
      totalHours: 0,
      windowStart: null,
      windowEnd: null,
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
  rules.push({
    id: "avg_48h",
    label: "Average ≤ 48h / week (over reference period)",
    status:
      spanWeeks < 4
        ? "indeterminate"
        : avgWeekly <= 48
          ? "pass"
          : "fail",
    detail:
      spanWeeks < 4
        ? `Only ${spanWeeks.toFixed(1)} weeks of data — need ≥4 weeks to average meaningfully (${totalHours} h logged)`
        : `${avgWeekly.toFixed(1)} h/week averaged over ${spanWeeks.toFixed(1)} weeks (${totalHours} h / ${spanDays} working day${spanDays === 1 ? "" : "s"})${leaveNote}`,
    evidence: {
      windowStart: refStartISO,
      windowEnd: refEndISO,
      shifts: shifts.map(summarise),
      notes: [
        `${shifts.length} shift(s) totalling ${totalHours} h across ${spanDays} contracted day(s) ≈ ${spanWeeks.toFixed(1)} weeks${leaveNote}`,
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
      max72Breaches.push({ date: shifts[i].date, note: `${hSum} h in 7-day window starting ${shifts[i].date}` });
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
        : { shifts: long13.map(summarise), notes: long13.map((s) => `${s.date} ${s.session}: ${s.hours} h`) },
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
  const longRunShifts =
    bestRunStart >= 0
      ? shifts.slice(bestRunStart, bestRunEnd + 1).filter((s) => s.isLong).map(summarise)
      : [];
  rules.push({
    id: "max_5_long",
    label: "Max 5 consecutive long shifts (>10h)",
    status: maxRunLong <= 5 ? "pass" : "fail",
    detail: `Longest run of consecutive long shifts: ${maxRunLong}`,
    evidence:
      longRunShifts.length === 0
        ? undefined
        : {
            windowStart: longRunShifts[0].date,
            windowEnd: longRunShifts[longRunShifts.length - 1].date,
            shifts: longRunShifts,
            notes: [`Longest unbroken run of >10 h shifts: ${maxRunLong} day(s)`],
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
      ? shifts.slice(bestNightStart, bestNightEnd + 1).filter((s) => s.isNight).map(summarise)
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

  // R6 — Max 7 consecutive days worked. Leave days bridge a run because
  // annual / study leave does not count as a rostered day off under TCS.
  const days = Array.from(new Set(shifts.map((s) => s.date))).sort();
  let runDays = 0;
  let maxRunDays = 0;
  let prevDay: number | null = null;
  let dayRunStart = 0;
  let bestDayStart = 0;
  let bestDayEnd = 0;
  const onlyLeaveBetween = (prevMs: number, curMs: number): boolean => {
    // Every calendar day strictly between prev and cur must be a leave day.
    if (curMs - prevMs <= MS_DAY) return true;
    for (let t = prevMs + MS_DAY; t < curMs; t += MS_DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      if (!leaveDates.has(iso)) return false;
    }
    return true;
  };
  for (let k = 0; k < days.length; k++) {
    const d = days[k];
    const dMs = dateAtHour(d, 0);
    if (prevDay !== null && (dMs - prevDay === MS_DAY || onlyLeaveBetween(prevDay, dMs))) {
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


  // R9 — No more than 1 weekend in 2 worked
  const weekendsWorked = new Set<string>();
  for (const s of shifts) {
    if (!s.isWeekend) continue;
    const d = new Date(s.startMs);
    const day = d.getUTCDay();
    const satMs = day === 6 ? s.startMs : s.startMs - MS_DAY;
    weekendsWorked.add(new Date(satMs).toISOString().slice(0, 10));
  }
  const sortedWE = Array.from(weekendsWorked).sort();
  const backToBackPairs: Array<[string, string]> = [];
  for (let k = 1; k < sortedWE.length; k++) {
    const prev = new Date(sortedWE[k - 1] + "T00:00:00Z").getTime();
    const cur = new Date(sortedWE[k] + "T00:00:00Z").getTime();
    if (cur - prev === 7 * MS_DAY) backToBackPairs.push([sortedWE[k - 1], sortedWE[k]]);
  }
  const weekendShifts = shifts.filter((s) => s.isWeekend).map(summarise);
  rules.push({
    id: "weekend_freq",
    label: "No more than 1 weekend in 2 worked",
    status: backToBackPairs.length === 0 ? "pass" : "fail",
    detail:
      `${weekendsWorked.size} weekend(s) worked in window` +
      (backToBackPairs.length ? ` · ${backToBackPairs.length} back-to-back weekend pair(s)` : ""),
    evidence:
      weekendShifts.length === 0
        ? undefined
        : {
            shifts: weekendShifts,
            notes:
              backToBackPairs.length > 0
                ? backToBackPairs.map(([a, b]) => `Back-to-back: weekend of ${a} & weekend of ${b}`)
                : [`Worked weekends (Sat keys): ${sortedWE.join(", ")}`],
          },
  });

  // R10 — Max 8 days worked in any 14
  let max8in14 = 0;
  let peak14Start = 0;
  for (let k = 0; k < days.length; k++) {
    const startMs = dateAtHour(days[k], 0);
    let count = 0;
    for (let l = k; l < days.length; l++) {
      const dMs = dateAtHour(days[l], 0);
      if (dMs - startMs >= 14 * MS_DAY) break;
      count++;
    }
    if (count > max8in14) {
      max8in14 = count;
      peak14Start = k;
    }
  }
  const peak14StartDate = days[peak14Start];
  const peak14EndDate = addDaysISO(peak14StartDate, 13);
  rules.push({
    id: "max_8_in_14",
    label: "Max 8 days worked in any 14",
    status: max8in14 <= 8 ? "pass" : "fail",
    detail: `Peak: ${max8in14} working days in a rolling 14-day window`,
    evidence: {
      windowStart: peak14StartDate,
      windowEnd: peak14EndDate,
      shifts: shiftsInDayRange(peak14StartDate, peak14EndDate).map(summarise),
      notes: [`${max8in14} working day(s) in the 14-day window ${peak14StartDate} → ${peak14EndDate}`],
    },
  });

  const hasFail = rules.some((r) => r.status === "fail");
  const overall: AuditResult["overall"] = hasFail ? "non_compliant" : "compliant";

  return {
    overall,
    totalShifts: shifts.length,
    totalHours,
    windowStart,
    windowEnd,
    rules,
    shifts: shifts.map(summarise),
  };
}
