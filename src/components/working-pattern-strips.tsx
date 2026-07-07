import type { ReactNode } from "react";
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
// Cells hold a min-width floor so on very narrow viewports the parent
// container (see PatternStripsScroll) can overflow horizontally instead
// of squeezing "AM+PM" + "67%" into an unreadable sliver.
export const ROW_CLASS = "flex items-center gap-1.5 sm:gap-2 text-xs";
export const ROW_LABEL_CLASS =
  "w-14 sm:w-24 shrink-0 truncate text-[11px] leading-tight sm:text-[13px] sm:leading-snug md:text-sm text-muted-foreground";
export const STRIP_CLASS = "flex flex-1 min-w-0 gap-0.5 sm:gap-1";
export const CELL_CLASS =
  "flex-1 min-w-[2.75rem] sm:min-w-0 overflow-hidden whitespace-nowrap";
// Reusable per-breakpoint text tokens so every strip renders labels and
// share-values at the same size step across mobile → sm → md.
const CELL_LABEL_TEXT =
  "text-[10px] leading-none sm:text-[11px] sm:leading-tight md:text-[12px]";
const CELL_SHARE_TEXT =
  "text-[9px] leading-none sm:text-[10px] md:text-[11px] font-normal opacity-90 tabular-nums";

/**
 * Wrapper that lets the whole stack of weekday strips (WeekdayHeader,
 * AmPmStrip, Private/SAG, SPA, On-call) scroll horizontally as one unit
 * when the card is narrower than the strips' natural minimum width. All
 * rows share the same scroll offset so their weekday columns stay
 * aligned. On sm+ the strips fit and scrolling is disabled so the layout
 * matches the card edges exactly.
 */
export function PatternStripsScroll({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-x-auto sm:overflow-visible -mx-3 px-3 sm:mx-0 sm:px-0"
      role="table"
      aria-label="Weekday working pattern breakdown"
    >
      <div
        role="rowgroup"
        className="min-w-[20rem] sm:min-w-0 space-y-1.5"
      >
        {children}
      </div>
    </div>
  );
}

// Focus ring applied to every keyboard-focusable strip cell. Uses the
// design-system `ring` token so the ring adapts to light/dark mode.
const CELL_FOCUS_CLASS =
  "focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

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
    <div className={ROW_CLASS} role="row">
      <div className={ROW_LABEL_CLASS} role="rowheader">
        SPA
      </div>
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
          const description = active
            ? `SPA ${a && p ? "morning and afternoon" : a ? "morning" : "afternoon"}` +
              (hasShare
                ? `, ${count} of ${totalSessions} SPA sessions, ${pct} percent`
                : "")
            : hasShare
              ? `${count} of ${totalSessions} SPA sessions, ${pct} percent, below regularity threshold`
              : "no regular SPA session";
          const focusable = active || hasShare;
          return (
            <div
              key={d}
              data-testid={`spa-cell-${d}`}
              role="gridcell"
              tabIndex={focusable ? 0 : -1}
              aria-label={`${WEEKDAY_LABELS[d]}: ${description}`}
              className={
                CELL_CLASS +
                " flex flex-col items-center justify-center rounded border font-medium px-0.5 " +
                CELL_LABEL_TEXT +
                " " +
                CELL_FOCUS_CLASS +
                " " +
                (shareText !== null ? "py-0.5 sm:py-1" : "h-6 sm:h-7") +
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
              <span aria-hidden="true">{label}</span>
              {shareText !== null && (
                <span
                  data-testid={`spa-pct-${d}`}
                  className={CELL_SHARE_TEXT}
                  aria-hidden="true"
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
    <div className={ROW_CLASS} role="row">
      <div className={ROW_LABEL_CLASS} role="rowheader">
        {label}
      </div>
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
          const lowerLabel = label.toLowerCase();
          const description = hasShare
            ? `${count} of ${totalSessions} ${lowerLabel} sessions, ${pct} percent` +
              (active ? "" : ", below regularity threshold")
            : active
              ? `regular ${lowerLabel} day`
              : `no ${lowerLabel} activity`;
          const focusable = active || hasShare;
          return (
            <div
              key={d}
              data-testid={`weekday-cell-${d}`}
              role="gridcell"
              tabIndex={focusable ? 0 : -1}
              aria-label={`${WEEKDAY_LABELS[d]}: ${description}`}
              className={
                CELL_CLASS +
                " flex flex-col items-center justify-center rounded border font-medium px-0.5 " +
                CELL_LABEL_TEXT +
                " " +
                CELL_FOCUS_CLASS +
                " " +
                (shareText !== null ? "py-0.5 sm:py-1" : "h-6 sm:h-7") +
                " " +
                (active
                  ? highlightClass
                  : "border-border bg-muted/40 text-muted-foreground")
              }
              title={
                WEEKDAY_LABELS[d] +
                (hasShare
                  ? ` · ${count} of ${totalSessions} ${lowerLabel} sessions (${pct}%)` +
                    (active ? "" : " — below regularity threshold")
                  : "")
              }
            >
              <span aria-hidden="true">
                {active ? WEEKDAY_LABELS[d].slice(0, 3) : "–"}
              </span>
              {shareText !== null && (
                <span
                  data-testid={`weekday-pct-${d}`}
                  className={CELL_SHARE_TEXT}
                  aria-hidden="true"
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
