import { WEEKDAY_LABELS } from "@/lib/staff-working-patterns";

/**
 * How each populated cell displays its share of total sessions:
 *   - "percent": rounded percentage of total (default, matches historical behaviour).
 *   - "count":   raw session count for that weekday.
 * Empty cells (count === 0 or totalSessions === 0) are suppressed in both modes.
 */
export type StripDisplayMode = "percent" | "count";

// Shared column geometry — kept in sync with the sibling rows rendered by
// the staff working-patterns route (WeekdayHeader / AmPmStrip live there).
export const ROW_CLASS = "flex items-center gap-2 text-xs";
export const ROW_LABEL_CLASS =
  "w-20 sm:w-24 shrink-0 truncate text-muted-foreground";
export const STRIP_CLASS = "flex flex-1 min-w-0 gap-1";
export const CELL_CLASS = "flex-1 min-w-0 overflow-hidden";

/**
 * Render a single "SPA" row for the working-patterns card. Each cell shows
 * the AM/PM label for that weekday and — when the consultant has any SPA
 * sessions in the recent window — the percentage of their total SPA
 * sessions that fell on that day. When `totalSessions` is 0 the percentage
 * is suppressed (no divide-by-zero, no misleading 0%/NaN%).
 */
export function SpaStrip({
  amDays,
  pmDays,
  countsByWeekday,
  totalSessions,
  displayMode = "percent",
}: {
  amDays: number[];
  pmDays: number[];
  countsByWeekday: number[];
  totalSessions: number;
  displayMode?: StripDisplayMode;
}) {
  const am = new Set(amDays);
  const pm = new Set(pmDays);
  return (
    <div className={ROW_CLASS}>
      <div className={ROW_LABEL_CLASS}>SPA</div>
      <div className={STRIP_CLASS}>
        {[1, 2, 3, 4, 5].map((d) => {
          const a = am.has(d);
          const p = pm.has(d);
          const active = a || p;
          const label = a && p ? "AM+PM" : a ? "AM" : p ? "PM" : "–";
          const count = countsByWeekday[d] ?? 0;
          const hasShare = totalSessions > 0 && count > 0;
          const pct = hasShare
            ? Math.round((count / totalSessions) * 100)
            : null;
          const shareText =
            displayMode === "count"
              ? hasShare
                ? String(count)
                : null
              : pct !== null
                ? `${pct}%`
                : null;
          return (
            <div
              key={d}
              data-testid={`spa-cell-${d}`}
              className={
                CELL_CLASS +
                " flex flex-col items-center justify-center rounded border text-[10px] font-medium leading-none px-0.5 " +
                (shareText !== null ? "py-0.5" : "h-6") +
                " " +
                (active
                  ? "bg-sky-600 text-white border-sky-600 dark:bg-sky-500 dark:border-sky-500"
                  : "border-border bg-muted/40 text-muted-foreground")
              }
              title={
                `${WEEKDAY_LABELS[d]}` +
                (active
                  ? ` · SPA ${label}` +
                    (hasShare
                      ? ` · ${count} of ${totalSessions} SPA sessions (${pct}%)`
                      : "")
                  : hasShare
                    ? ` · ${count} of ${totalSessions} SPA sessions (${pct}%) — below regularity threshold`
                    : "")
              }
            >
              <span>{label}</span>
              {shareText !== null && (
                <span
                  data-testid={`spa-pct-${d}`}
                  className="text-[9px] font-normal opacity-90 tabular-nums"
                >
                  {shareText}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Render a highlighted weekday row (Private/SAG, On-call, …). When
 * `countsByWeekday` and a positive `totalSessions` are supplied, each
 * highlighted cell also shows the % of total sessions on that weekday.
 * With `totalSessions === 0` the percentage is suppressed on every cell.
 */
export function WeekdayStrip({
  label,
  highlighted,
  tone = "default",
  countsByWeekday,
  totalSessions,
  displayMode = "percent",
}: {
  label: string;
  highlighted: number[];
  tone?: "default" | "primary" | "amber";
  countsByWeekday?: number[];
  totalSessions?: number;
  displayMode?: StripDisplayMode;
}) {
  const set = new Set(highlighted);
  const highlightClass =
    tone === "primary"
      ? "bg-primary text-primary-foreground border-primary"
      : tone === "amber"
        ? "bg-amber-500/90 text-white border-amber-500 dark:bg-amber-500 dark:border-amber-500"
        : "bg-foreground text-background border-foreground";
  return (
    <div className={ROW_CLASS}>
      <div className={ROW_LABEL_CLASS}>{label}</div>
      <div className={STRIP_CLASS}>
        {[1, 2, 3, 4, 5].map((d) => {
          const active = set.has(d);
          const count = countsByWeekday?.[d] ?? 0;
          const hasShare =
            !!countsByWeekday &&
            !!totalSessions &&
            totalSessions > 0 &&
            count > 0;
          const pct = hasShare
            ? Math.round((count / totalSessions!) * 100)
            : null;
          const shareText =
            displayMode === "count"
              ? hasShare
                ? String(count)
                : null
              : pct !== null
                ? `${pct}%`
                : null;
          return (
            <div
              key={d}
              data-testid={`weekday-cell-${d}`}
              className={
                CELL_CLASS +
                " flex flex-col items-center justify-center rounded border text-[11px] font-medium leading-none px-0.5 " +
                (shareText !== null ? "py-0.5" : "h-6") +
                " " +
                (active
                  ? highlightClass
                  : "border-border bg-muted/40 text-muted-foreground")
              }
              title={
                WEEKDAY_LABELS[d] +
                (hasShare
                  ? ` · ${count} of ${totalSessions} ${label.toLowerCase()} sessions (${pct}%)` +
                    (active ? "" : " — below regularity threshold")
                  : "")
              }
            >
              <span>{active ? WEEKDAY_LABELS[d].slice(0, 3) : "–"}</span>
              {shareText !== null && (
                <span
                  data-testid={`weekday-pct-${d}`}
                  className="text-[9px] font-normal opacity-90 tabular-nums"
                >
                  {shareText}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
