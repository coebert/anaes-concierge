import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { QueryErrorNotice } from "@/components/query-state-notice";
import { PageLoading } from "@/components/loading";
import { ChevronDown, Gauge, RefreshCw } from "lucide-react";
import { cn, formatDateGB } from "@/lib/utils";
import { riskColor, riskLabel } from "./robustness";
import {
  TAG_SCAN_MAX_CHARS,
  TAG_SOURCE_LABEL,
  UNVERIFIED_REASONS,
  halfLabel,
  type LabelCapture,
  type UnverifiedReason,
  type UnverifiedSlot,
  type PressureDay,
  type PressureLevel,
  type StaffingStatus,
  type TaggedList,
  type TheatrePressureForecast,
} from "./theatre-pressure";
import {
  WEEK_STATUS_HELP,
  WEEK_STATUS_LABEL,
  type TimelineStatus,
  type WeekStatusTimeline,
} from "./rota-week-status";
import { isoWeekStart } from "@/features/clwrota/week-status-core";
import {
  importWeekHelp,
  importWeekLabel,
  type ImportCoverageTimeline,
  type ImportWeekEntry,
  type ImportWeekState,
} from "./rota-sync-coverage";

const LEVEL_LABEL: Record<PressureLevel, string> = {
  elevated: "Potential pressure — elevated",
  potential: "Potential pressure",
  unverified: "Staffing unverified",
  noted: "Tagged — no pressure reason",
};

const LEVEL_CLASS: Record<PressureLevel, string> = {
  elevated: "border-destructive/50 bg-destructive/10 text-destructive",
  potential: "border-warning/50 bg-warning-muted text-warning",
  unverified: "border-border bg-muted text-muted-foreground",
  noted: "border-border bg-background text-muted-foreground",
};

export interface TheatrePressureCardProps {
  forecast: TheatrePressureForecast | null;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  staffingError: unknown;
  staffingLoading: boolean;
  /** Re-reads list labels and cover (e.g. after the rota is re-imported). */
  onRefresh?: () => void;
  isRefreshing?: boolean;
  /** Week rota status as observed by the import (optional). */
  weekStatus?: {
    timeline: WeekStatusTimeline | null;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
  };
  /** Per-week import coverage / freshness (optional; separate from publication state). */
  importCoverage?: {
    timeline: ImportCoverageTimeline | null;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
  };
}

export function TheatrePressureCard(props: TheatrePressureCardProps) {
  const { forecast, isLoading, error, onRetry, staffingError, staffingLoading } = props;
  return (
    <Card aria-labelledby="theatre-pressure-title">
      <CardHeader>
        <CardTitle
          id="theatre-pressure-title"
          className="flex flex-wrap items-center gap-2 text-base"
        >
          <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
          Theatre pressure forecast
          <Badge variant="outline" className="text-[10px]">
            v1 · read-only
          </Badge>
          {props.onRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-7 gap-1 text-xs"
              onClick={props.onRefresh}
              disabled={props.isRefreshing}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", props.isRefreshing && "animate-spin")}
                aria-hidden
              />
              {props.isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null}
        </CardTitle>
        <CardDescription>
          Days where lists explicitly labelled <strong>VRAM</strong>, <strong>DIEP</strong> or{" "}
          <strong>robot / robotic / robotics</strong> may add potential pressure, using the same
          AM/PM cover as the daily headroom table on this screen. This flags potential pressure only
          — it does not predict overruns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <QueryErrorNotice
            error={error}
            onRetry={onRetry}
            what="theatre list labels"
            stale={!!forecast}
          />
        ) : null}
        {!forecast && !error && isLoading ? <PageLoading /> : null}
        {forecast ? (
          <>
            {staffingError ? (
              <p
                role="status"
                className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"
              >
                Staffing cover couldn't be loaded, so every tagged half below is shown as{" "}
                <em>not verified</em> rather than OK. Use Retry on the daily headroom table below.
              </p>
            ) : staffingLoading && !forecast.staffingAvailable ? (
              <p role="status" className="text-xs text-muted-foreground">
                Staffing cover is still loading — halves show as not verified until it arrives.
              </p>
            ) : null}
            <Totals forecast={forecast} />
            {forecast.days.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No list in this window carries a VRAM, DIEP or robotic label in the fields we can
                read. This is not a confirmation that none are planned — see detection limits below.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Date</th>
                      <th className="px-2 py-1 text-left font-medium">Signal</th>
                      <th className="px-2 py-1 text-left font-medium">Tagged lists</th>
                      <th className="px-2 py-1 text-left font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecast.days.map((d) => (
                      <DayRow key={d.date} day={d} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {props.weekStatus || props.importCoverage ? (
              <WeekStatusStrip status={props.weekStatus} imports={props.importCoverage} />
            ) : null}
            <UnverifiedSlots
              slots={forecast.unverifiedSlots}
              capture={forecast.labelCapture}
              weeks={
                props.weekStatus?.timeline?.capture === "available" && !props.weekStatus.error
                  ? props.weekStatus.timeline
                  : null
              }
              imports={
                props.importCoverage?.timeline?.capture === "available" &&
                !props.importCoverage.error
                  ? props.importCoverage.timeline
                  : null
              }
            />
            <DetectionLimits forecast={forecast} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Totals({ forecast }: { forecast: TheatrePressureForecast }) {
  const t = forecast.totals;
  const lists =
    t.distinctListsMin === t.distinctListsMax
      ? `${t.distinctListsMin}`
      : `${t.distinctListsMin}–${t.distinctListsMax}`;
  const items: Array<[string, string]> = [
    ["Days with tagged lists", String(t.taggedDays)],
    ["Distinct tagged lists", lists],
    ["Elevated days", String(t.elevatedDays)],
    ["Potential-pressure days", String(t.potentialDays)],
    ["Days with unverified cover", String(t.unverifiedDays)],
    ["Unverified slots", String(t.unverifiedSlots)],
  ];
  return (
    <dl className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-md border p-2">
          <dt className="text-[11px] text-muted-foreground">{k}</dt>
          <dd className="text-lg font-semibold tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DayRow({ day }: { day: PressureDay }) {
  return (
    <tr className="border-t align-top" data-testid="pressure-day">
      <td className="whitespace-nowrap px-2 py-2">
        <Link
          to="/robustness/day/$date"
          params={{ date: day.date }}
          className="text-primary hover:underline"
        >
          {formatDateGB(day.date)}
        </Link>
      </td>
      <td className="px-2 py-2">
        <span
          className={cn(
            "inline-block whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-medium",
            LEVEL_CLASS[day.level],
          )}
        >
          {LEVEL_LABEL[day.level]}
        </span>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {day.distinctMin === day.distinctMax
            ? `${day.distinctMin} distinct list${day.distinctMin === 1 ? "" : "s"}`
            : `${day.distinctMin}–${day.distinctMax} distinct lists (unresolved)`}
        </div>
      </td>
      <td className="px-2 py-2">
        <ul className="space-y-1.5">
          {day.lists.map((l) => (
            <ListLine key={l.key} list={l} />
          ))}
        </ul>
      </td>
      <td className="px-2 py-2">
        {day.reasons.length === 0 ? (
          <span className="text-muted-foreground">
            Tagged list with OK cover in its half — no pressure reason.
          </span>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4">
            {day.reasons.map((r) => (
              <li key={r.code}>{r.text}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function StaffingChip({ status }: { status: StaffingStatus }) {
  if (status === "not_assessed") {
    return (
      <span className="rounded border border-dashed px-1.5 py-0.5 text-[10px] text-muted-foreground">
        Not verified
      </span>
    );
  }
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", riskColor(status))}>
      {riskLabel(status)}
    </span>
  );
}

function ListLine({ list }: { list: TaggedList }) {
  const identityNote =
    list.identity === "all_day_same_title"
      ? "one all-day list (same theatre and title in AM and PM)"
      : list.identity === "possibly_same_as_other_half"
        ? "may be the same list as the other half — not confirmed"
        : null;
  return (
    <li className="space-y-0.5" data-testid="pressure-list">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{list.theatreName}</span>
        <span className="text-muted-foreground">·</span>
        <span>{list.halves.map(halfLabel).join(" + ")}</span>
        {list.tags.map((t) => (
          <Badge key={t} variant="secondary" className="text-[10px]">
            {t}
          </Badge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>Cover:</span>
        {list.staffing.map((s) => (
          <span key={s.half} className="inline-flex items-center gap-1">
            {halfLabel(s.half)} <StaffingChip status={s.status} />
          </span>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground">
        Found in: {list.sources.map((s) => TAG_SOURCE_LABEL[s]).join(", ")}
        {identityNote ? ` · ${identityNote}` : ""}
      </div>
    </li>
  );
}

function DetectionLimits({ forecast }: { forecast: TheatrePressureForecast }) {
  const t = forecast.totals;
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        Detection limits and unverified inputs
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            Only explicit whole-word labels are matched (VRAM, DIEP, robot, robotic, robotics; any
            case). Procedures are never inferred from the surgeon, the theatre name or the
            specialty. Other wording (for example a robot brand name) is not detected.
          </li>
          {forecast.labelCapture === "available" ? (
            <li>
              Fields read: the imported list titles and list notes (kept separately, as supplied in
              the rota), any coordinator list note and linked assignment notes. Place notes such as
              “off site” count as a known label but are not scanned for tags. The original text is
              stored privately and never shown here — only the tags found. There are no structured
              procedure tags yet, and there is no manual confirm/override in this version.
            </li>
          ) : (
            <li>
              Fields read: the legacy imported list title, any coordinator list note and linked
              assignment notes. Separate capture of original list titles and notes isn&apos;t
              switched on yet (database update pending), so labels held in other fields are not
              available. There are no structured procedure tags yet, and there is no manual
              confirm/override in this version.
            </li>
          )}
          <li>
            {t.untitledLists} of {t.listsInWindow} list(s) in this window have no title or note, so
            whether they are tagged is unknown.
          </li>
          {t.unresolvedPairs > 0 ? (
            <li>
              {t.unresolvedPairs} AM/PM pair(s) in the same theatre could be one all-day list or two
              lists; they are counted as a range and never as confirmed 2-list days.
            </li>
          ) : null}
          <li>
            {t.weekdaysWithoutLists} weekday(s) in the window have no imported lists at all — the
            rota may not be published yet. Those days are not assessed, not zero-risk.
          </li>
          <li>
            Cover is only modelled for weekday AM and PM. Weekend, evening and night lists show “Not
            verified”.
          </li>
          {t.truncatedScans > 0 ? (
            <li>
              {t.truncatedScans} list(s) had a label longer than {TAG_SCAN_MAX_CHARS} characters;
              only the start was scanned.
            </li>
          ) : null}
          {t.excludedInactiveTagged > 0 ? (
            <li>
              {t.excludedInactiveTagged} tagged list(s) on inactive theatres were left out, matching
              the cover table.
            </li>
          ) : null}
          {t.missingTheatre > 0 ? (
            <li>{t.missingTheatre} list(s) could not be matched to a known theatre.</li>
          ) : null}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

const REASON_LABEL: Record<UnverifiedReason, string> = {
  blank_in_source: "Blank in rota",
  partial_evidence: "Partial import",
  not_captured: "Title not captured",
  no_linked_rows: "No imported rows",
  no_imported_lists: "No lists imported",
};

function reasonHelp(reason: UnverifiedReason, capture: LabelCapture): string {
  switch (reason) {
    case "blank_in_source":
      return "The last complete import supplied this list with no title or note.";
    case "partial_evidence":
      return "Blank, but the last import for this day skipped some rows, so the blank isn't confirmed.";
    case "not_captured":
      return capture === "available"
        ? "Imported before titles and notes were kept separately — the next import will confirm it."
        : "Imported rows exist, but original titles and notes aren't captured yet.";
    case "no_linked_rows":
      return "No imported rota rows are linked to this list, so there's no source title to check.";
    case "no_imported_lists":
      return "No lists at all were imported for this weekday.";
  }
}

type ReasonFilter = UnverifiedReason | "all";

function UnverifiedSlots({
  slots,
  capture,
  weeks,
  imports,
}: {
  slots: UnverifiedSlot[];
  capture: LabelCapture;
  weeks: WeekStatusTimeline | null;
  imports: ImportCoverageTimeline | null;
}) {
  const [filter, setFilter] = useState<ReasonFilter>("all");
  const counts = useMemo(() => {
    const m = new Map<UnverifiedReason, number>();
    for (const s of slots) m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
    return m;
  }, [slots]);
  const shown = filter === "all" ? slots : slots.filter((s) => s.reason === filter);
  const options: ReasonFilter[] = ["all", ...UNVERIFIED_REASONS.filter((r) => counts.has(r))];
  return (
    <section aria-labelledby="unverified-slots-title" className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="unverified-slots-title" className="text-sm font-semibold">
          Unverified slots
        </h3>
        <Badge variant={slots.length ? "outline" : "secondary"} className="text-[10px]">
          {slots.length}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Lists whose title or note can&apos;t be verified, so whether they are tagged is unknown —
        recheck these once the rota is published, then use Refresh.{" "}
        {weeks
          ? "The Week column is the rota feed's own week status as last seen by the import."
          : "Week publication status isn't recorded yet, so it isn't shown."}{" "}
        {imports
          ? "The Import column says whether a complete import has confirmed that week, and when."
          : null}
      </p>
      {slots.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Every imported list in this window has a title or note.
        </p>
      ) : (
        <>
          <div role="group" aria-label="Filter unverified slots" className="flex flex-wrap gap-1.5">
            {options.map((o) => {
              const n = o === "all" ? slots.length : (counts.get(o) ?? 0);
              const active = filter === o;
              return (
                <Button
                  key={o}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  aria-pressed={active}
                  className="h-7 text-xs"
                  onClick={() => setFilter(o)}
                >
                  {o === "all" ? "All" : REASON_LABEL[o]} ({n})
                </Button>
              );
            })}
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Date</th>
                  <th className="px-2 py-1 text-left font-medium">Theatre</th>
                  <th className="px-2 py-1 text-left font-medium">Half</th>
                  {weeks ? <th className="px-2 py-1 text-left font-medium">Week</th> : null}
                  {imports ? <th className="px-2 py-1 text-left font-medium">Import</th> : null}
                  <th className="px-2 py-1 text-left font-medium">Why unverified</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.key} className="border-t align-top" data-testid="unverified-slot">
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Link
                        to="/robustness/day/$date"
                        params={{ date: s.date }}
                        className="text-primary hover:underline"
                      >
                        {formatDateGB(s.date)}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5">{s.theatreName ?? "All theatres"}</td>
                    <td className="px-2 py-1.5">{s.half ? halfLabel(s.half) : "—"}</td>
                    {weeks ? (
                      <td className="px-2 py-1.5">
                        <WeekChip
                          status={weeks.byWeek.get(isoWeekStart(s.date))?.status ?? "not_observed"}
                        />
                      </td>
                    ) : null}
                    {imports ? (
                      <td className="px-2 py-1.5">
                        <ImportChip entry={imports.byWeek.get(isoWeekStart(s.date)) ?? null} />
                      </td>
                    ) : null}
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{REASON_LABEL[s.reason]}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {reasonHelp(s.reason, capture)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

const WEEK_CHIP_CLASS: Record<TimelineStatus, string> = {
  published: "border-success/40 bg-success/10 text-success",
  setup: "border-warning/40 bg-warning-muted text-warning",
  not_setup: "border-border bg-muted text-muted-foreground",
  mixed: "border-warning/40 bg-warning-muted text-warning",
  unknown: "border-dashed border-border text-muted-foreground",
  other: "border-dashed border-border text-muted-foreground",
  not_observed: "border-dashed border-border text-muted-foreground",
};

export function WeekChip({ status }: { status: TimelineStatus }) {
  return (
    <span
      title={WEEK_STATUS_HELP[status]}
      className={cn(
        "inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium",
        WEEK_CHIP_CLASS[status],
      )}
    >
      {WEEK_STATUS_LABEL[status]}
    </span>
  );
}

const IMPORT_CHIP_CLASS: Record<ImportWeekState, string> = {
  current: "border-success/40 bg-success/10 text-success",
  stale: "border-warning/40 bg-warning-muted text-warning",
  incomplete: "border-warning/40 bg-warning-muted text-warning",
  attempt_problem: "border-destructive/40 bg-destructive/10 text-destructive",
  not_tracked: "border-dashed border-border text-muted-foreground",
};

export function ImportChip({ entry }: { entry: ImportWeekEntry | null }) {
  if (!entry) {
    return (
      <span className="inline-block whitespace-nowrap rounded border border-dashed px-1.5 py-0.5 text-[10px] text-muted-foreground">
        Import not tracked
      </span>
    );
  }
  return (
    <span
      title={importWeekHelp(entry)}
      data-testid="import-chip"
      className={cn(
        "inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium",
        IMPORT_CHIP_CLASS[entry.state],
      )}
    >
      {importWeekLabel(entry)}
    </span>
  );
}

/**
 * Two separate facts per week, never merged:
 *   - Rota status: the feed's own week status (published / setup / …), as last seen;
 *   - Import: whether a complete import has confirmed every day, when (last
 *     known good), and whether the newest attempt had a problem.
 */
function WeekStatusStrip({
  status,
  imports,
}: {
  status?: TheatrePressureCardProps["weekStatus"];
  imports?: TheatrePressureCardProps["importCoverage"];
}) {
  const statusTl =
    status?.timeline && !status.error && status.timeline.capture === "available"
      ? status.timeline
      : null;
  const importTl =
    imports?.timeline && !imports.error && imports.timeline.capture === "available"
      ? imports.timeline
      : null;
  const weekStarts = (statusTl?.weeks ?? importTl?.weeks ?? []).map((w) => w.weekStart);
  return (
    <section aria-labelledby="week-status-title" className="space-y-2 rounded-md border p-3">
      <h3 id="week-status-title" className="text-sm font-semibold">
        Rota weeks — status and import
      </h3>
      {status?.error ? (
        <QueryErrorNotice
          error={status.error}
          onRetry={status.onRetry}
          what="rota week status"
          stale={!!status.timeline}
        />
      ) : null}
      {imports?.error ? (
        <QueryErrorNotice
          error={imports.error}
          onRetry={imports.onRetry}
          what="rota import coverage"
          stale={!!imports.timeline}
        />
      ) : null}
      {(status && !status.timeline && !status.error && status.isLoading) ||
      (imports && !imports.timeline && !imports.error && imports.isLoading) ? (
        <p className="text-xs text-muted-foreground">Loading week status…</p>
      ) : null}
      {status?.timeline && !status.error && status.timeline.capture === "not_installed" ? (
        <p className="text-xs text-muted-foreground">
          Week status from the rota feed isn&apos;t recorded yet (database update pending), so no
          week is shown as published or draft.
        </p>
      ) : null}
      {imports?.timeline && !imports.error && imports.timeline.capture === "not_installed" ? (
        <p className="text-xs text-muted-foreground">
          Import date tracking isn&apos;t switched on yet (database update pending), so how up to
          date each week&apos;s import is isn&apos;t shown.
        </p>
      ) : null}
      {weekStarts.length > 0 ? (
        <>
          <p className="text-xs text-muted-foreground">
            {statusTl ? (
              <>
                <strong>Status</strong> is the rota feed&apos;s own label for the week, as last
                seen — “Checked” is when the import saw it, not when the rota was published.
                Weeks never seen show “Not checked”.{" "}
              </>
            ) : null}
            {importTl ? (
              <>
                <strong>Import</strong> says whether a complete import has confirmed every day of
                the week, and when. A partial or failed attempt keeps the last known good time.
                {importTl.trackingSince
                  ? ` Import tracking started ${formatDateGB(importTl.trackingSince.slice(0, 10))}; earlier weeks aren't tracked.`
                  : " No import has been tracked yet."}
              </>
            ) : null}
          </p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Rota weeks">
            {weekStarts.map((wk) => {
              const w = statusTl?.byWeek.get(wk);
              const imp = importTl?.byWeek.get(wk) ?? null;
              return (
                <li
                  key={wk}
                  data-testid="week-status"
                  className="flex flex-col gap-0.5 rounded border px-2 py-1 text-[11px]"
                >
                  <span className="text-muted-foreground">w/c {formatDateGB(wk)}</span>
                  {statusTl ? (
                    <span className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">Status</span>
                      <WeekChip status={w?.status ?? "not_observed"} />
                    </span>
                  ) : null}
                  {w?.observedAt ? (
                    <span
                      className={cn(
                        "text-[10px]",
                        w.stale ? "text-warning" : "text-muted-foreground",
                      )}
                    >
                      Checked {formatDateGB(w.observedAt.slice(0, 10))}
                      {w.stale ? " · may be out of date" : ""}
                    </span>
                  ) : null}
                  {importTl ? (
                    <span className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">Import</span>
                      <ImportChip entry={imp} />
                    </span>
                  ) : null}
                  {imp?.lastKnownGoodAt ? (
                    <span className="text-[10px] text-muted-foreground">
                      Good as of {formatDateGB(imp.lastKnownGoodAt.slice(0, 10))}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
