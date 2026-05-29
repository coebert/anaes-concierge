import { supabase } from "@/integrations/supabase/client";

export interface LeaveRow {
  id: string;
  staff_id: string;
  start_date: string;
  end_date: string;
  status: string;
  type: string;
  half_day_start: string | null;
  half_day_end: string | null;
}

export interface StaffMini {
  id: string;
  full_name: string;
  grade: string | null;
}

export interface DayPressure {
  date: string; // YYYY-MM-DD
  total: number;
  approved: number;
  pending: number;
  byGrade: Record<string, number>;
  names: string[];
}

export interface WeekPressure {
  weekStart: string; // Monday
  total: number; // sum of off-days across week
  peakDay: string;
  peak: number;
  byGrade: Record<string, number>;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDate(start: string, end: string): string[] {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  const out: string[] = [];
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(isoDate(d));
  }
  return out;
}

function mondayOf(dateISO: string): string {
  const d = new Date(dateISO + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDate(d);
}

/**
 * Build a per-day map of leave pressure across [rangeStart, rangeEnd] (inclusive).
 * Includes approved + pending leave. Weekends are skipped from the pressure count.
 */
export async function loadLeavePressure(
  rangeStart: string,
  rangeEnd: string,
): Promise<{
  days: DayPressure[];
  weeks: WeekPressure[];
  staff: Map<string, StaffMini>;
}> {
  const { data: leave } = await supabase
    .from("leave_requests")
    .select("id, staff_id, start_date, end_date, status, type, half_day_start, half_day_end")
    .in("status", ["approved", "pending"])
    .lte("start_date", rangeEnd)
    .gte("end_date", rangeStart);

  const rows = (leave ?? []) as LeaveRow[];
  const staffIds = [...new Set(rows.map((r) => r.staff_id))];

  const staff = new Map<string, StaffMini>();
  if (staffIds.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, full_name, grade")
      .in("id", staffIds);
    for (const p of profs ?? []) {
      staff.set(p.id, { id: p.id, full_name: p.full_name, grade: p.grade });
    }
  }

  // Build per-day buckets across the requested range (weekdays only).
  const dayMap = new Map<string, DayPressure>();
  for (const d of eachDate(rangeStart, rangeEnd)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    dayMap.set(d, {
      date: d,
      total: 0,
      approved: 0,
      pending: 0,
      byGrade: {},
      names: [],
    });
  }

  for (const r of rows) {
    const from = r.start_date < rangeStart ? rangeStart : r.start_date;
    const to = r.end_date > rangeEnd ? rangeEnd : r.end_date;
    for (const d of eachDate(from, to)) {
      const bucket = dayMap.get(d);
      if (!bucket) continue;
      bucket.total += 1;
      if (r.status === "approved") bucket.approved += 1;
      else bucket.pending += 1;
      const grade = staff.get(r.staff_id)?.grade ?? "unknown";
      bucket.byGrade[grade] = (bucket.byGrade[grade] ?? 0) + 1;
      const nm = staff.get(r.staff_id)?.full_name;
      if (nm && !bucket.names.includes(nm)) bucket.names.push(nm);
    }
  }

  const days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Roll up to ISO weeks (Mon..Fri).
  const weekMap = new Map<string, WeekPressure>();
  for (const d of days) {
    const wk = mondayOf(d.date);
    const cur = weekMap.get(wk) ?? {
      weekStart: wk,
      total: 0,
      peakDay: d.date,
      peak: 0,
      byGrade: {},
    };
    cur.total += d.total;
    if (d.total > cur.peak) {
      cur.peak = d.total;
      cur.peakDay = d.date;
    }
    for (const [g, n] of Object.entries(d.byGrade)) {
      cur.byGrade[g] = (cur.byGrade[g] ?? 0) + n;
    }
    weekMap.set(wk, cur);
  }

  const weeks = [...weekMap.values()].sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : 1,
  );

  return { days, weeks, staff };
}

export function pressureColor(count: number, peak: number): string {
  if (count === 0) return "bg-muted/40";
  const pct = peak > 0 ? count / peak : 0;
  if (pct >= 0.85) return "bg-red-500/80 text-white";
  if (pct >= 0.65) return "bg-orange-500/70 text-white";
  if (pct >= 0.4) return "bg-amber-400/70";
  if (pct >= 0.2) return "bg-yellow-300/60";
  return "bg-emerald-300/50";
}
