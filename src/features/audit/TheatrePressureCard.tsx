import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { QueryErrorNotice } from "@/components/query-state-notice";
import { PageLoading } from "@/components/loading";
import { ChevronDown, Gauge } from "lucide-react";
import { cn, formatDateGB } from "@/lib/utils";
import { riskColor, riskLabel } from "./robustness";
import {
  TAG_SCAN_MAX_CHARS,
  TAG_SOURCE_LABEL,
  halfLabel,
  type PressureDay,
  type PressureLevel,
  type StaffingStatus,
  type TaggedList,
  type TheatrePressureForecast,
} from "./theatre-pressure";

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
}

export function TheatrePressureCard(props: TheatrePressureCardProps) {
  const { forecast, isLoading, error, onRetry, staffingError, staffingLoading } = props;
  return (
    <Card aria-labelledby="theatre-pressure-title">
      <CardHeader>
        <CardTitle id="theatre-pressure-title" className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
          Theatre pressure forecast
          <Badge variant="outline" className="text-[10px]">
            v1 · read-only
          </Badge>
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
  ];
  return (
    <dl className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
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
          <li>
            Fields read: the imported list title, any coordinator list note and linked assignment
            notes. The rota import stores only the first free-text field of each row, so labels held
            in later fields are not available. There are no structured procedure tags yet, and there
            is no manual confirm/override in this version.
          </li>
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
