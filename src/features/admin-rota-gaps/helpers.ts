import type { syncClwRotaRota } from "@/features/clwrota/clwrota.functions";

export type WindowChoice = "30" | "90" | "180" | "rotation";
export const WINDOW_LABEL: Record<WindowChoice, string> = {
  "30": "Last 30 days",
  "90": "Last 90 days",
  "180": "Last 6 months",
  rotation: "Full rotation",
};

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * A single trainee's sync_missing span, tagged with the metrics needed to
 * prioritise it: how many working days are missing and which trainee it
 * belongs to (so merged spans can count distinct trainees covered).
 */
export interface SpanInput {
  startISO: string;
  endISO: string;
  missingDays: number;
  traineeId: string;
}

export interface MergedSpan {
  startISO: string;
  endISO: string;
  /** Sum of missing weekdays across every trainee gap inside this span. */
  missingDays: number;
  /** Distinct trainees with at least one gap inside this span. */
  trainees: number;
  /** Distinct trainee IDs with at least one gap inside this span. */
  traineeIds: string[];
}

/**
 * Merge overlapping or near-adjacent date ranges so a single targeted sync
 * can cover several trainees' sync_missing gaps in one request.
 */
export function mergeRanges(spans: SpanInput[], bridgeDays = 7): MergedSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) =>
    a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0,
  );
  type Acc = MergedSpan & { traineeSet: Set<string> };
  const acc: Acc[] = [];
  for (const s of sorted) {
    const last = acc[acc.length - 1];
    if (last && s.startISO <= addDaysISO(last.endISO, bridgeDays)) {
      if (s.endISO > last.endISO) last.endISO = s.endISO;
      last.missingDays += s.missingDays;
      last.traineeSet.add(s.traineeId);
      last.trainees = last.traineeSet.size;
    } else {
      const set = new Set<string>([s.traineeId]);
      acc.push({
        startISO: s.startISO,
        endISO: s.endISO,
        missingDays: s.missingDays,
        trainees: 1,
        traineeIds: [],
        traineeSet: set,
      });
    }
  }
  return acc.map(({ traineeSet, ...m }) => ({
    ...m,
    traineeIds: Array.from(traineeSet),
  }));
}

export type SyncPriority = "coverage" | "recency" | "trainees";

export const PRIORITY_LABEL: Record<SyncPriority, string> = {
  coverage: "Most missing days first",
  recency: "Most recent gaps first",
  trainees: "Most trainees affected first",
};

export function prioritiseSpans(spans: MergedSpan[], priority: SyncPriority): MergedSpan[] {
  const sorted = [...spans];
  switch (priority) {
    case "coverage":
      sorted.sort((a, b) =>
        b.missingDays - a.missingDays ||
        (a.startISO < b.startISO ? 1 : a.startISO > b.startISO ? -1 : 0),
      );
      break;
    case "recency":
      sorted.sort((a, b) =>
        (a.endISO < b.endISO ? 1 : a.endISO > b.endISO ? -1 : 0) ||
        b.missingDays - a.missingDays,
      );
      break;
    case "trainees":
      sorted.sort((a, b) =>
        b.trainees - a.trainees ||
        b.missingDays - a.missingDays,
      );
      break;
  }
  return sorted;
}

export type SyncResult = Awaited<ReturnType<typeof syncClwRotaRota>>;

/**
 * Snapshot of the rota-gaps query result used by the post-sync verification.
 */
export type GapSnapshot = {
  trainees: Array<{
    id: string;
    start_date: string | null;
    rotation_end_date: string | null;
    ltft_days_off: number[] | null;
  }>;
  datesByStaff: Map<string, Set<string>>;
  today: string;
};

const MS_DAY_LOCAL = 86_400_000;

function isoFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Count working weekdays (excluding weekends and the trainee's LTFT off
 * days) in `[fromISO, toISO]` that lie inside the trainee's rotation
 * window and have no rota assignment.
 */
export function countSyncMissingInSpan(
  snap: GapSnapshot,
  fromISO: string,
  toISO: string,
): number {
  if (fromISO > toISO) return 0;
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td);
  let missing = 0;
  for (const t of snap.trainees) {
    const offSet = new Set<number>([0, 6, ...((t.ltft_days_off ?? []) as number[])]);
    const rotStart = t.start_date ?? null;
    const rotEnd = t.rotation_end_date ?? snap.today;
    const dates = snap.datesByStaff.get(t.id) ?? new Set<string>();
    for (let dt = new Date(from); dt.getTime() <= to.getTime(); dt = new Date(dt.getTime() + MS_DAY_LOCAL)) {
      const iso = isoFromDate(dt);
      if (rotStart && iso < rotStart) continue;
      if (iso > rotEnd) continue;
      if (offSet.has(dt.getDay())) continue;
      if (dates.has(iso)) continue;
      missing += 1;
    }
  }
  return missing;
}

export function countSyncMissingForTraineeInSpan(
  snap: GapSnapshot,
  traineeId: string,
  fromISO: string,
  toISO: string,
): number {
  const t = snap.trainees.find((x) => x.id === traineeId);
  if (!t || fromISO > toISO) return 0;
  const offSet = new Set<number>([0, 6, ...((t.ltft_days_off ?? []) as number[])]);
  const rotStart = t.start_date ?? null;
  const rotEnd = t.rotation_end_date ?? snap.today;
  const dates = snap.datesByStaff.get(t.id) ?? new Set<string>();
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td);
  let missing = 0;
  for (let dt = new Date(from); dt.getTime() <= to.getTime(); dt = new Date(dt.getTime() + MS_DAY_LOCAL)) {
    const iso = isoFromDate(dt);
    if (rotStart && iso < rotStart) continue;
    if (iso > rotEnd) continue;
    if (offSet.has(dt.getDay())) continue;
    if (dates.has(iso)) continue;
    missing += 1;
  }
  return missing;
}

export type TraineeDiagnosticStatus =
  | "fully_filled"
  | "partially_filled"
  | "no_upstream_coverage"
  | "covered_no_new_dates"
  | "no_gap_in_range";

export interface TraineeDiagnostic {
  traineeId: string;
  name: string;
  gapsBefore: number;
  gapsAfter: number;
  gapsFilled: number;
  upstreamDatesCovered: number;
  upstreamInsertedDates: number;
  upstreamExistingDates: number;
  firstUpstreamDate: string | null;
  lastUpstreamDate: string | null;
  status: TraineeDiagnosticStatus;
}

export interface SyncProgress {
  running: boolean;
  current: number;
  total: number;
  perRange: Array<{
    from: string;
    to: string;
    ok: boolean;
    message?: string;
    upserted?: number;
    inserted?: number;
    updated?: number;
    unmatchedStaffCount?: number;
    gapsBefore?: number;
    gapsAfter?: number;
    gapsFilled?: number;
    rowsInWindow?: number;
    staffCovered?: number;
    topSkipReasons?: Array<{ reason: string; count: number }>;
    traineeDiagnostics?: TraineeDiagnostic[];
  }>;
  error?: string;
}
