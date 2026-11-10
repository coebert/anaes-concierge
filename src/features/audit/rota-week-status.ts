/**
 * Week rota status as OBSERVED by the CLWRota import (browser side).
 *
 * Reads `clwrota_week_status` (member-readable, pending migration 0009).
 * Every week in the window gets an entry; weeks the import never observed
 * are "not_observed" — never a status inferred from missing rows. Times are
 * the app's observation times, not publication times.
 */
import { supabase } from "@/integrations/supabase/client";
import { isoWeekStart, type WeekStatusCode } from "@/features/clwrota/week-status-core";
import { fetchAllRowsPaged } from "./paginate";

export type WeekStatusCapture = "available" | "not_installed";
export type TimelineStatus = WeekStatusCode | "not_observed";

export interface WeekStatusRow {
  week_start: string;
  status_code: WeekStatusCode;
  source_values: string[] | null;
  rows_seen: number;
  planned_rows: number;
  actual_rows: number;
  observed_at: string;
  status_since: string;
}

export interface WeekStatusEntry {
  weekStart: string;
  status: TimelineStatus;
  /** The feed's own words for the status (e.g. "Not setup"). */
  sourceValues: string[];
  observedAt: string | null;
  statusSince: string | null;
  plannedRows: number;
  actualRows: number;
  /** Last observation older than STALE_AFTER_DAYS. */
  stale: boolean;
}

export interface WeekStatusTimeline {
  capture: WeekStatusCapture;
  weeks: WeekStatusEntry[];
  byWeek: Map<string, WeekStatusEntry>;
}

export const STALE_AFTER_DAYS = 3;
const KNOWN: ReadonlySet<string> = new Set([
  "published",
  "setup",
  "not_setup",
  "mixed",
  "unknown",
  "other",
]);

export const WEEK_STATUS_LABEL: Record<TimelineStatus, string> = {
  published: "Published",
  setup: "Setup",
  not_setup: "Not setup",
  mixed: "Mixed",
  unknown: "Status blank",
  other: "Other status",
  not_observed: "Not checked",
};

export const WEEK_STATUS_HELP: Record<TimelineStatus, string> = {
  published: "The rota feed reports this week as Published.",
  setup: "The rota feed reports this week as Setup (set up, not marked Published).",
  not_setup: "The rota feed reports this week as Not setup — rows may be planned entries only.",
  mixed: "The feed reported more than one status in this week.",
  unknown: "The feed returned rows for this week but no status.",
  other: "The feed reported a status the app doesn't recognise.",
  not_observed: "The import hasn't seen any rota rows for this week, so its status is unknown.",
};

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function buildWeekStatusTimeline(input: {
  rangeStart: string;
  rangeEnd: string;
  rows: WeekStatusRow[];
  capture: WeekStatusCapture;
  now: Date;
}): WeekStatusTimeline {
  const { rangeStart, rangeEnd, rows, capture, now } = input;
  const byStart = new Map(rows.map((r) => [r.week_start, r]));
  const weeks: WeekStatusEntry[] = [];
  for (let w = isoWeekStart(rangeStart); w <= rangeEnd; w = addDays(w, 7)) {
    const r = capture === "available" ? byStart.get(w) : undefined;
    const status: TimelineStatus = r
      ? KNOWN.has(r.status_code)
        ? r.status_code
        : "other"
      : "not_observed";
    const observedMs = r ? Date.parse(r.observed_at) : NaN;
    weeks.push({
      weekStart: w,
      status,
      sourceValues: (r?.source_values ?? []).filter((v) => typeof v === "string").slice(0, 5),
      observedAt: r?.observed_at ?? null,
      statusSince: r?.status_since ?? null,
      plannedRows: r?.planned_rows ?? 0,
      actualRows: r?.actual_rows ?? 0,
      stale:
        Number.isFinite(observedMs) && now.getTime() - observedMs > STALE_AFTER_DAYS * 86_400_000,
    });
  }
  return { capture, weeks, byWeek: new Map(weeks.map((e) => [e.weekStart, e])) };
}

type QueryError = { code?: string; message?: string } | null;
interface WeekStatusQuery {
  from(t: "clwrota_week_status"): {
    select(c: string): {
      gte(
        col: string,
        v: string,
      ): {
        lte(
          col: string,
          v: string,
        ): {
          order(
            col: "week_start",
            o: { ascending: boolean },
          ): {
            range(
              a: number,
              b: number,
            ): PromiseLike<{ data: WeekStatusRow[] | null; error: QueryError }>;
          };
        };
      };
    };
  };
}

export function isMissingWeekStatusRelation(e: QueryError): boolean {
  if (!e) return false;
  return e.code === "42P01" || e.code === "PGRST205";
}

/** Complete paged read. Missing table → not_installed; any other error throws (Retry). */
export async function loadWeekStatus(
  rangeStart: string,
  rangeEnd: string,
  client: unknown = supabase,
): Promise<{ rows: WeekStatusRow[]; capture: WeekStatusCapture }> {
  const q = client as WeekStatusQuery;
  let missing = false;
  const rows = await fetchAllRowsPaged<WeekStatusRow>(
    async (from, to) => {
      const res = await q
        .from("clwrota_week_status")
        .select(
          "week_start,status_code,source_values,rows_seen,planned_rows,actual_rows,observed_at,status_since",
        )
        .gte("week_start", isoWeekStart(rangeStart))
        .lte("week_start", rangeEnd)
        .order("week_start", { ascending: true })
        .range(from, to);
      if (from === 0 && isMissingWeekStatusRelation(res.error)) {
        missing = true;
        return { data: [], error: null };
      }
      return res;
    },
    { rowKey: (r) => r.week_start, label: "clwrota_week_status" },
  );
  return missing ? { rows: [], capture: "not_installed" } : { rows, capture: "available" };
}
