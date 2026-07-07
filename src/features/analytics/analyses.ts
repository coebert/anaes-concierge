// HR analytics pack — pure TS analyses computed over data the app already
// holds. Each function takes plain rows and returns aggregates suitable for
// direct rendering.

import { gini } from "@/lib/analytics-gini";

// ---------- shared helpers ----------

const DAY_MS = 86_400_000;

export function isoWeekendDay(iso: string): boolean {
  const d = new Date(iso + "T00:00:00Z").getUTCDay();
  return d === 0 || d === 6;
}

export function monthsAgo(now: Date, months: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export function ltftFraction(
  daysOff: readonly (string | number)[] | null | undefined,
): number {
  // profiles.ltft_days_off is an array of weekday indices (0..5 items).
  // 10 half-day sessions/week is 1.0 WTE. Each recorded day off = 0.2 WTE.
  const n = daysOff?.length ?? 0;
  return Math.max(0.1, Math.min(1, 1 - n * 0.2));
}

// ---------- 1. Allocation fairness ----------

export interface AllocRotaRow {
  staff_id: string;
  session_date: string;
  duty_type: string | null;
  role_on_list: string | null;
  specialty_id: string | null;
}

export interface AllocationFairnessRow {
  staff_id: string;
  totalSessions: number;
  listTypeCount: number;
  listTypeGini: number;
  weekendCount: number;
  weekendShare: number;
  onCallCount: number;
  onCallShare: number;
  byListType: Array<{ specialty_id: string | null; count: number }>;
}

const ONCALL_DUTY = new Set([
  "icu_consultant_oncall",
  "general_consultant_oncall",
  "registrar_oncall",
  "sho_oncall",
  "nhh_oncall",
]);

export function computeAllocationFairness(
  rows: AllocRotaRow[],
): AllocationFairnessRow[] {
  const byStaff = new Map<string, AllocRotaRow[]>();
  for (const r of rows) {
    const arr = byStaff.get(r.staff_id);
    if (arr) arr.push(r);
    else byStaff.set(r.staff_id, [r]);
  }
  const out: AllocationFairnessRow[] = [];
  for (const [staff_id, rs] of byStaff) {
    const listCounts = new Map<string | null, number>();
    let weekend = 0;
    let oncall = 0;
    for (const r of rs) {
      listCounts.set(r.specialty_id, (listCounts.get(r.specialty_id) ?? 0) + 1);
      if (isoWeekendDay(r.session_date)) weekend++;
      if (
        r.role_on_list === "on_call" ||
        (r.duty_type && ONCALL_DUTY.has(r.duty_type))
      )
        oncall++;
    }
    const byListType = [...listCounts.entries()]
      .map(([specialty_id, count]) => ({ specialty_id, count }))
      .sort((a, b) => b.count - a.count);
    const total = rs.length;
    out.push({
      staff_id,
      totalSessions: total,
      listTypeCount: listCounts.size,
      listTypeGini: gini(byListType.map((b) => b.count)),
      weekendCount: weekend,
      weekendShare: total ? weekend / total : 0,
      onCallCount: oncall,
      onCallShare: total ? oncall / total : 0,
      byListType,
    });
  }
  return out.sort((a, b) => b.listTypeGini - a.listTypeGini);
}

// ---------- 2. Short-notice changes ----------

export interface ShortNoticeRow {
  staff_id: string | null;
  action: string;
  hours_before_session: number | null;
  changed_at: string;
}

export interface ShortNoticeAgg {
  staff_id: string;
  totalShortNotice: number;
  added: number;
  removed: number;
  medianHoursBefore: number | null;
}

export function computeShortNotice(rows: ShortNoticeRow[]): ShortNoticeAgg[] {
  const byStaff = new Map<string, ShortNoticeRow[]>();
  for (const r of rows) {
    if (!r.staff_id) continue;
    if (r.hours_before_session == null || r.hours_before_session > 48) continue;
    const arr = byStaff.get(r.staff_id);
    if (arr) arr.push(r);
    else byStaff.set(r.staff_id, [r]);
  }
  const out: ShortNoticeAgg[] = [];
  for (const [staff_id, rs] of byStaff) {
    const hours = rs
      .map((r) => r.hours_before_session!)
      .sort((a, b) => a - b);
    const m = hours.length
      ? hours.length % 2
        ? hours[(hours.length - 1) / 2]
        : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2
      : null;
    out.push({
      staff_id,
      totalShortNotice: rs.length,
      added: rs.filter((r) => r.action === "insert" || r.action === "create")
        .length,
      removed: rs.filter((r) => r.action === "delete" || r.action === "remove")
        .length,
      medianHoursBefore: m,
    });
  }
  return out.sort((a, b) => b.totalShortNotice - a.totalShortNotice);
}

// ---------- 3. Leave denial reasons ----------

const REASON_RULES: Array<[RegExp, string]> = [
  [/rota|cover|staffing|short/, "rota pressure"],
  [/conflict|clash|overlap/, "conflict with other leave"],
  [/notice|late|deadline/, "insufficient notice"],
  [/quota|allowance|budget|limit/, "quota exceeded"],
  [/list|theatre|cepod|on.?call/, "list/on-call impact"],
];

export function classifyDenialReason(text: string | null | undefined): string {
  if (!text) return "unspecified";
  const t = text.toLowerCase();
  for (const [re, label] of REASON_RULES) if (re.test(t)) return label;
  return "other";
}

export interface DenialInputRow {
  status: string;
  decided_at: string | null;
  decision_notes: string | null;
  grade: string | null;
}

export interface DenialAgg {
  byCategory: Array<{ category: string; count: number }>;
  byMonth: Array<{ month: string; count: number }>;
  byGradeCategory: Array<{
    grade: string;
    category: string;
    count: number;
  }>;
  total: number;
}

export function computeDenials(rows: DenialInputRow[]): DenialAgg {
  const denied = rows.filter((r) => r.status === "rejected");
  const cat = new Map<string, number>();
  const month = new Map<string, number>();
  const gc = new Map<string, number>();
  for (const r of denied) {
    const c = classifyDenialReason(r.decision_notes);
    cat.set(c, (cat.get(c) ?? 0) + 1);
    if (r.decided_at) {
      const m = r.decided_at.slice(0, 7);
      month.set(m, (month.get(m) ?? 0) + 1);
    }
    const g = r.grade ?? "unknown";
    const k = `${g}::${c}`;
    gc.set(k, (gc.get(k) ?? 0) + 1);
  }
  return {
    total: denied.length,
    byCategory: [...cat.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    byMonth: [...month.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    byGradeCategory: [...gc.entries()]
      .map(([k, count]) => {
        const [grade, category] = k.split("::");
        return { grade, category, count };
      })
      .sort((a, b) => b.count - a.count),
  };
}

// ---------- 4. Trainee educational exposure ----------

export interface TraineeExposureRow {
  staff_id: string;
  training_level: string | null;
  bySpecialty: Array<{
    specialty_id: string;
    delivered: number;
    required: number;
    ratio: number; // delivered / required, 1+ = green, 0.7-1 amber, <0.7 red
    band: "green" | "amber" | "red" | "no-target";
  }>;
  underexposedCount: number;
}

export function computeTraineeExposure(input: {
  trainees: Array<{ id: string; training_level: string | null }>;
  assignments: Array<{ staff_id: string; specialty_id: string | null }>;
  targets: Array<{
    training_level: string;
    specialty_id: string;
    required_sessions: number;
  }>;
}): TraineeExposureRow[] {
  const targetsByLevel = new Map<string, Map<string, number>>();
  for (const t of input.targets) {
    if (!targetsByLevel.has(t.training_level))
      targetsByLevel.set(t.training_level, new Map());
    targetsByLevel
      .get(t.training_level)!
      .set(t.specialty_id, t.required_sessions);
  }
  const deliveredByStaff = new Map<string, Map<string, number>>();
  for (const a of input.assignments) {
    if (!a.specialty_id) continue;
    if (!deliveredByStaff.has(a.staff_id))
      deliveredByStaff.set(a.staff_id, new Map());
    const m = deliveredByStaff.get(a.staff_id)!;
    m.set(a.specialty_id, (m.get(a.specialty_id) ?? 0) + 1);
  }
  const out: TraineeExposureRow[] = [];
  for (const t of input.trainees) {
    const delivered = deliveredByStaff.get(t.id) ?? new Map();
    const targets = t.training_level
      ? targetsByLevel.get(t.training_level) ?? new Map()
      : new Map();
    const specialties = new Set([...delivered.keys(), ...targets.keys()]);
    const bySpecialty: TraineeExposureRow["bySpecialty"] = [];
    let underexposed = 0;
    for (const s of specialties) {
      const d = delivered.get(s) ?? 0;
      const r = targets.get(s) ?? 0;
      let band: TraineeExposureRow["bySpecialty"][number]["band"];
      let ratio: number;
      if (r === 0) {
        band = "no-target";
        ratio = 0;
      } else {
        ratio = d / r;
        if (ratio >= 1) band = "green";
        else if (ratio >= 0.7) band = "amber";
        else {
          band = "red";
          underexposed++;
        }
      }
      bySpecialty.push({
        specialty_id: s,
        delivered: d,
        required: r,
        ratio,
        band,
      });
    }
    bySpecialty.sort((a, b) => a.ratio - b.ratio);
    out.push({
      staff_id: t.id,
      training_level: t.training_level,
      bySpecialty,
      underexposedCount: underexposed,
    });
  }
  return out.sort((a, b) => b.underexposedCount - a.underexposedCount);
}

// ---------- 5. On-call frequency inequality ----------

export interface OnCallInequalityRow {
  staff_id: string;
  ltftFraction: number;
  onCallCount: number;
  onCallPerWTE: number;
  band: "full-time" | "0.8" | "0.6" | "0.4-and-under";
  outlier: boolean;
}

export function computeOnCallInequality(input: {
  consultants: Array<{ id: string; ltft_days_off: readonly (string | number)[] | null }>;
  onCallRows: Array<{ staff_id: string }>;
}): { rows: OnCallInequalityRow[]; giniOverall: number; byBand: Record<string, { median: number; count: number }> } {
  const counts = new Map<string, number>();
  for (const r of input.onCallRows)
    counts.set(r.staff_id, (counts.get(r.staff_id) ?? 0) + 1);

  const bandOf = (f: number): OnCallInequalityRow["band"] => {
    if (f >= 0.95) return "full-time";
    if (f >= 0.75) return "0.8";
    if (f >= 0.55) return "0.6";
    return "0.4-and-under";
  };

  const rows: OnCallInequalityRow[] = input.consultants.map((c) => {
    const f = ltftFraction(c.ltft_days_off);
    const n = counts.get(c.id) ?? 0;
    return {
      staff_id: c.id,
      ltftFraction: f,
      onCallCount: n,
      onCallPerWTE: n / f,
      band: bandOf(f),
      outlier: false,
    };
  });

  // Band medians and outlier flag (>1.5× band median)
  const byBand: Record<string, { median: number; count: number }> = {};
  const groups = new Map<string, OnCallInequalityRow[]>();
  for (const r of rows) {
    if (!groups.has(r.band)) groups.set(r.band, []);
    groups.get(r.band)!.push(r);
  }
  for (const [b, gs] of groups) {
    const perWTE = gs.map((g) => g.onCallPerWTE).sort((a, b) => a - b);
    const median = perWTE.length
      ? perWTE.length % 2
        ? perWTE[(perWTE.length - 1) / 2]
        : (perWTE[perWTE.length / 2 - 1] + perWTE[perWTE.length / 2]) / 2
      : 0;
    byBand[b] = { median, count: gs.length };
    for (const g of gs) if (median > 0 && g.onCallPerWTE > 1.5 * median) g.outlier = true;
  }
  return {
    rows: rows.sort((a, b) => b.onCallPerWTE - a.onCallPerWTE),
    giniOverall: gini(rows.map((r) => r.onCallPerWTE)),
    byBand,
  };
}

// ---------- 6. Sickness seasonality ----------

export interface SicknessSeasonalityCell {
  month: string; // YYYY-MM
  absenceDays: number;
  rotaSessions: number;
}

export function computeSicknessSeasonality(input: {
  sickRows: Array<{ start_date: string; end_date: string }>;
  rotaRows: Array<{ session_date: string }>;
}): {
  cells: SicknessSeasonalityCell[];
  pearson: number | null;
  byMonthOfYear: Array<{ mm: string; days: number }>;
} {
  const perMonth = new Map<string, { d: number; s: number }>();
  const bump = (m: string, k: "d" | "s", v = 1) => {
    const c = perMonth.get(m) ?? { d: 0, s: 0 };
    c[k] += v;
    perMonth.set(m, c);
  };
  for (const r of input.sickRows) {
    const s = new Date(r.start_date + "T00:00:00Z").getTime();
    const e = new Date(r.end_date + "T00:00:00Z").getTime();
    for (let t = s; t <= e; t += DAY_MS) {
      bump(new Date(t).toISOString().slice(0, 7), "d");
    }
  }
  for (const r of input.rotaRows) bump(r.session_date.slice(0, 7), "s");

  const cells = [...perMonth.entries()]
    .map(([month, v]) => ({ month, absenceDays: v.d, rotaSessions: v.s }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Pearson between absenceDays and rotaSessions across months
  let pearson: number | null = null;
  if (cells.length >= 3) {
    const xs = cells.map((c) => c.absenceDays);
    const ys = cells.map((c) => c.rotaSessions);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    pearson = dx && dy ? num / Math.sqrt(dx * dy) : null;
  }

  const byMonth = new Map<string, number>();
  for (const c of cells) {
    const mm = c.month.slice(5);
    byMonth.set(mm, (byMonth.get(mm) ?? 0) + c.absenceDays);
  }
  const byMonthOfYear = [...byMonth.entries()]
    .map(([mm, days]) => ({ mm, days }))
    .sort((a, b) => a.mm.localeCompare(b.mm));

  return { cells, pearson, byMonthOfYear };
}

// ---------- 7. Handover-adjacency risk ----------

const HIGH_ACUITY = /obstet|icu|itu|cepod|trauma|cardiac|vascular|emergency/i;

export interface HandoverRiskRow {
  staff_id: string;
  events: number;
  sessions: Array<{ date: string; from: string; to: string }>;
}

export function computeHandoverRisk(rows: {
  staff_id: string;
  session_date: string;
  session: string; // am/pm/eve/night
  specialty_name: string | null;
}[]): HandoverRiskRow[] {
  const order: Record<string, number> = { am: 0, pm: 1, eve: 2, night: 3 };
  const byStaff = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byStaff.get(r.staff_id);
    if (arr) arr.push(r);
    else byStaff.set(r.staff_id, [r]);
  }
  const out: HandoverRiskRow[] = [];
  for (const [staff_id, rs] of byStaff) {
    rs.sort(
      (a, b) =>
        a.session_date.localeCompare(b.session_date) ||
        (order[a.session] ?? 9) - (order[b.session] ?? 9),
    );
    const evs: HandoverRiskRow["sessions"] = [];
    for (let i = 1; i < rs.length; i++) {
      const p = rs[i - 1];
      const c = rs[i];
      if (
        p.session_date === c.session_date &&
        (order[c.session] ?? 9) === (order[p.session] ?? 9) + 1 &&
        HIGH_ACUITY.test(p.specialty_name ?? "") &&
        HIGH_ACUITY.test(c.specialty_name ?? "")
      ) {
        evs.push({
          date: c.session_date,
          from: `${p.session}:${p.specialty_name ?? "?"}`,
          to: `${c.session}:${c.specialty_name ?? "?"}`,
        });
      }
    }
    if (evs.length)
      out.push({ staff_id, events: evs.length, sessions: evs });
  }
  return out.sort((a, b) => b.events - a.events);
}

// ---------- 8. New-starter early-warning ----------

export interface NewStarterRow {
  staff_id: string;
  start_date: string;
  daysSinceStart: number;
  sicknessDays: number;
  exceptionReports: number;
  shortNoticeReceived: number;
  score: number; // higher = more concerning
}

export function computeNewStarterWarnings(input: {
  newStarters: Array<{ id: string; start_date: string }>;
  sickRows: Array<{ staff_id: string; start_date: string; end_date: string }>;
  exceptionRows: Array<{ trainee_id: string; created_at: string }>;
  shortNoticeRows: ShortNoticeRow[];
  now: Date;
}): NewStarterRow[] {
  const nowMs = input.now.getTime();
  return input.newStarters
    .map((s) => {
      const startMs = new Date(s.start_date + "T00:00:00Z").getTime();
      const daysSinceStart = Math.floor((nowMs - startMs) / DAY_MS);
      const cutoff = startMs;
      const cap = Math.min(nowMs, startMs + 90 * DAY_MS);
      const sickness = input.sickRows
        .filter((r) => r.staff_id === s.id)
        .reduce((acc, r) => {
          const rs = new Date(r.start_date + "T00:00:00Z").getTime();
          const re = new Date(r.end_date + "T00:00:00Z").getTime();
          const lo = Math.max(rs, cutoff);
          const hi = Math.min(re, cap);
          return acc + Math.max(0, Math.floor((hi - lo) / DAY_MS) + 1);
        }, 0);
      const exceptions = input.exceptionRows.filter(
        (r) =>
          r.trainee_id === s.id &&
          new Date(r.created_at).getTime() >= cutoff &&
          new Date(r.created_at).getTime() <= cap,
      ).length;
      const shortNotice = input.shortNoticeRows.filter(
        (r) =>
          r.staff_id === s.id &&
          new Date(r.changed_at).getTime() >= cutoff &&
          new Date(r.changed_at).getTime() <= cap &&
          (r.hours_before_session ?? Infinity) <= 48,
      ).length;
      const score =
        sickness * 3 + exceptions * 4 + Math.min(shortNotice, 10) * 1;
      return {
        staff_id: s.id,
        start_date: s.start_date,
        daysSinceStart,
        sicknessDays: sickness,
        exceptionReports: exceptions,
        shortNoticeReceived: shortNotice,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}
