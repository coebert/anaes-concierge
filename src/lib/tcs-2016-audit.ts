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

export type RuleResult = {
  id: string;
  label: string;
  status: RuleStatus;
  detail: string;
  breaches?: Array<{ date: string; note: string }>;
};

export type AuditResult = {
  overall: "compliant" | "non_compliant" | "insufficient_data";
  totalShifts: number;
  totalHours: number;
  windowStart: string | null;
  windowEnd: string | null;
  rules: RuleResult[];
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

export function auditTcs2016(assignments: AuditAssignment[]): AuditResult {
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

  const rules: RuleResult[] = [];

  // R1 — Max 48h/week averaged over the rota's reference period (full window here).
  // Only meaningful with ≥4 weeks of data; otherwise mark indeterminate.
  const spanDays = Math.max(1, Math.round((shifts[shifts.length - 1].endMs - shifts[0].startMs) / MS_DAY));
  const spanWeeks = spanDays / 7;
  const avgWeekly = totalHours / spanWeeks;
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
        : `${avgWeekly.toFixed(1)} h/week averaged over ${spanWeeks.toFixed(1)} weeks (${totalHours} h / ${spanDays} d)`,
  });

  // R2 — Max 72h in any rolling 7 consecutive days
  let max72 = 0;
  const max72Breaches: Array<{ date: string; note: string }> = [];
  for (let i = 0; i < shifts.length; i++) {
    const windowEndMs = shifts[i].startMs + 7 * MS_DAY;
    let hSum = 0;
    for (let j = i; j < shifts.length && shifts[j].startMs < windowEndMs; j++) {
      hSum += shifts[j].hours;
    }
    if (hSum > max72) max72 = hSum;
    if (hSum > 72) {
      max72Breaches.push({ date: shifts[i].date, note: `${hSum} h in 7-day window starting ${shifts[i].date}` });
    }
  }
  rules.push({
    id: "max_72h_7d",
    label: "Max 72h in any 7 consecutive days",
    status: max72 <= 72 ? "pass" : "fail",
    detail: `Peak: ${max72} h in a rolling 7-day window`,
    breaches: max72Breaches.slice(0, 5),
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
  });

  // R4 — Max 5 consecutive long shifts (≥10h)
  let runLong = 0;
  let maxRunLong = 0;
  for (const s of shifts) {
    runLong = s.isLong ? runLong + 1 : 0;
    if (runLong > maxRunLong) maxRunLong = runLong;
  }
  rules.push({
    id: "max_5_long",
    label: "Max 5 consecutive long shifts (≥10h)",
    status: maxRunLong <= 5 ? "pass" : "fail",
    detail: `Longest run of long shifts: ${maxRunLong}`,
  });

  // R5 — Max 4 consecutive night shifts
  let runNight = 0;
  let maxRunNight = 0;
  for (const s of shifts) {
    runNight = s.isNight ? runNight + 1 : 0;
    if (runNight > maxRunNight) maxRunNight = runNight;
  }
  rules.push({
    id: "max_4_nights",
    label: "Max 4 consecutive night shifts",
    status: maxRunNight <= 4 ? "pass" : "fail",
    detail: `Longest run of nights: ${maxRunNight}`,
  });

  // R6 — Max 7 consecutive days worked
  let runDays = 0;
  let maxRunDays = 0;
  let prevDay: number | null = null;
  const days = Array.from(new Set(shifts.map((s) => s.date))).sort();
  for (const d of days) {
    const dMs = dateAtHour(d, 0);
    if (prevDay !== null && dMs - prevDay === MS_DAY) {
      runDays += 1;
    } else {
      runDays = 1;
    }
    if (runDays > maxRunDays) maxRunDays = runDays;
    prevDay = dMs;
  }
  rules.push({
    id: "max_7_consec_days",
    label: "Max 7 consecutive days worked",
    status: maxRunDays <= 7 ? "pass" : "fail",
    detail: `Longest run of consecutive working days: ${maxRunDays}`,
  });

  // R7 — Minimum 11h rest between shifts
  const rest11Breaches: Array<{ date: string; note: string }> = [];
  for (let i = 1; i < shifts.length; i++) {
    const gapH = (shifts[i].startMs - shifts[i - 1].endMs) / MS_HOUR;
    if (gapH < 11) {
      rest11Breaches.push({
        date: shifts[i].date,
        note: `${gapH.toFixed(1)} h rest after previous shift on ${shifts[i - 1].date}`,
      });
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
  });

  // R8 — Minimum 46h continuous rest after a run of ≥3 nights or ≥4 long shifts
  const rest46Breaches: Array<{ date: string; note: string }> = [];
  // walk runs of nights
  let i = 0;
  while (i < shifts.length) {
    if (shifts[i].isNight) {
      let j = i;
      while (j + 1 < shifts.length && shifts[j + 1].isNight) j++;
      const runLen = j - i + 1;
      if (runLen >= 3 && j + 1 < shifts.length) {
        const gapH = (shifts[j + 1].startMs - shifts[j].endMs) / MS_HOUR;
        if (gapH < 46) {
          rest46Breaches.push({
            date: shifts[j].date,
            note: `Only ${gapH.toFixed(1)} h rest after ${runLen} consecutive nights`,
          });
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  rules.push({
    id: "rest_46h_post_nights",
    label: "Min 46h continuous rest after ≥3 consecutive nights",
    status: rest46Breaches.length === 0 ? "pass" : "fail",
    detail:
      rest46Breaches.length === 0
        ? "No short post-nights rest gaps detected"
        : `${rest46Breaches.length} gap(s) under 46 h`,
    breaches: rest46Breaches.slice(0, 5),
  });

  // R9 — No more than 1 weekend in 2 worked (i.e. at most every other weekend)
  //   Definition: a "worked weekend" is any Sat or Sun with at least one shift.
  const weekendsWorked = new Set<string>(); // ISO-week-year key of the weekend
  for (const s of shifts) {
    if (!s.isWeekend) continue;
    const d = new Date(s.startMs);
    // Use the Saturday date of that weekend as the key
    const day = d.getUTCDay(); // 6=Sat, 0=Sun
    const satMs = day === 6 ? s.startMs : s.startMs - MS_DAY;
    weekendsWorked.add(new Date(satMs).toISOString().slice(0, 10));
  }
  const sortedWE = Array.from(weekendsWorked).sort();
  let backToBack = 0;
  for (let k = 1; k < sortedWE.length; k++) {
    const prev = new Date(sortedWE[k - 1] + "T00:00:00Z").getTime();
    const cur = new Date(sortedWE[k] + "T00:00:00Z").getTime();
    if (cur - prev === 7 * MS_DAY) backToBack++;
  }
  rules.push({
    id: "weekend_freq",
    label: "No more than 1 weekend in 2 worked",
    status: backToBack === 0 ? "pass" : "fail",
    detail:
      `${weekendsWorked.size} weekend(s) worked in window` +
      (backToBack ? ` · ${backToBack} back-to-back weekend pair(s)` : ""),
  });

  // R10 — Max 8 days worked in any 14
  let max8in14 = 0;
  for (let k = 0; k < days.length; k++) {
    const startMs = dateAtHour(days[k], 0);
    let count = 0;
    for (let l = k; l < days.length; l++) {
      const dMs = dateAtHour(days[l], 0);
      if (dMs - startMs >= 14 * MS_DAY) break;
      count++;
    }
    if (count > max8in14) max8in14 = count;
  }
  rules.push({
    id: "max_8_in_14",
    label: "Max 8 days worked in any 14",
    status: max8in14 <= 8 ? "pass" : "fail",
    detail: `Peak: ${max8in14} working days in a rolling 14-day window`,
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
  };
}
