import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertTriangle, ArrowRight, CalendarIcon, Clock, GraduationCap, Users, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { format, startOfMonth, startOfYear, subDays, subMonths } from "date-fns";
import { formatDateGB, cn } from "@/lib/utils";
import {
  getLastMinuteChangesAudit,
  type LastMinuteChangeRow,
  type StaffingGroup,
} from "@/lib/last-minute-changes.functions";

export const Route = createFileRoute(
  "/_authenticated/robustness/last-minute-changes",
)({
  component: LastMinuteChangesPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-4 text-sm text-destructive">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-4">Not found.</div>,
});

const GROUP_LABEL: Record<StaffingGroup, string> = {
  consultant: "Consultants",
  trainee:    "Trainees",
  sas:        "SAS doctors",
  anp:        "ANPs",
  other:      "Other",
  unknown:    "Unknown grade",
};

type DrillFilter =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "action"; action: "insert" | "update" | "delete" }
  | { kind: "action-pair"; actions: Array<"insert" | "delete"> }
  | { kind: "group"; group: StaffingGroup }
  | { kind: "group-action"; group: StaffingGroup; action: "insert" | "update" | "delete" };

function isoDaysAgo(days: number): string {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayISO(): string { return new Date().toISOString().slice(0, 10); }

function describeFilter(f: DrillFilter): string {
  switch (f.kind) {
    case "none":        return "";
    case "all":         return "All last-minute changes";
    case "action":      return `All ${f.action === "update" ? "moves/updates" : f.action + "s"}`;
    case "action-pair": return "All inserts + removals";
    case "group":       return `${GROUP_LABEL[f.group]} — all changes`;
    case "group-action":
      return `${GROUP_LABEL[f.group]} — ${f.action === "update" ? "moves/updates" : f.action + "s"}`;
  }
}

function applyFilter(rows: LastMinuteChangeRow[], f: DrillFilter): LastMinuteChangeRow[] {
  switch (f.kind) {
    case "none":        return [];
    case "all":         return rows;
    case "action":      return rows.filter((r) => r.action === f.action);
    case "action-pair": return rows.filter((r) => f.actions.includes(r.action as "insert" | "delete"));
    case "group":       return rows.filter((r) => r.group === f.group);
    case "group-action":
      return rows.filter((r) => r.group === f.group && r.action === f.action);
  }
}

// Display every timestamp in the viewer's local timezone, with the zone
// abbreviation appended so it is unambiguous. Hours-before is a duration
// (timezone-agnostic) but we re-derive it from the two absolute instants
// so the displayed value always matches the displayed times exactly.
const LOCAL_TZ = typeof Intl !== "undefined"
  ? Intl.DateTimeFormat().resolvedOptions().timeZone
  : "UTC";

const localDateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: LOCAL_TZ,
  year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});
const localTzAbbrFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: LOCAL_TZ, timeZoneName: "short", hour: "2-digit",
});

function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return localDateTimeFmt.format(d);
}

function localTzAbbr(): string {
  const parts = localTzAbbrFmt.formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? LOCAL_TZ;
}

function hoursBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (b - a) / 3_600_000;
}

function LastMinuteChangesPage() {
  const [rangeStart, setRangeStart] = useState(() => isoDaysAgo(90));
  const [rangeEnd, setRangeEnd] = useState(() => todayISO());
  const [filter, setFilter] = useState<DrillFilter>({ kind: "none" });
  const drillRef = useRef<HTMLDivElement | null>(null);

  const fetchAudit = useServerFn(getLastMinuteChangesAudit);
  const { data, isLoading, error } = useQuery({
    queryKey: ["last-minute-changes", rangeStart, rangeEnd],
    queryFn: () => fetchAudit({ data: { rangeStart, rangeEnd } }),
  });

  const drillRows = useMemo(
    () => (data ? applyFilter(data.rows, filter) : []),
    [data, filter],
  );

  const groupRows = useMemo(() => {
    if (!data) return [];
    const order: StaffingGroup[] = ["consultant", "trainee", "sas", "anp", "other", "unknown"];
    return order
      .map((g) => ({ group: g, ...data.byGroup[g] }))
      .filter((r) => r.total > 0);
  }, [data]);

  function drill(f: DrillFilter) {
    setFilter(f);
    requestAnimationFrame(() => drillRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Last minute changes audit
        </h1>
        <p className="text-sm text-muted-foreground">
          Counts every change to a rota assignment (insert, move or removal)
          made within <strong>48 hours</strong> of the scheduled start of the
          clinical activity. Click any total or row count below to drill into
          the underlying events.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Date range</CardTitle>
          <CardDescription>
            Filter by the <em>session date</em> of the affected clinical activity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DateRangeFilter
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onChange={(s, e) => { setRangeStart(s); setRangeEnd(e); setFilter({ kind: "none" }); }}
          />
        </CardContent>
      </Card>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {(error as Error).message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total last-minute changes"
              value={data?.totals.all ?? (isLoading ? "…" : 0)}
              icon={Clock} tone="amber"
              onClick={() => drill({ kind: "all" })} />
        <Stat label="Reassignments / moves"
              value={data?.totals.updates ?? (isLoading ? "…" : 0)}
              icon={Users} tone="orange"
              onClick={() => drill({ kind: "action", action: "update" })} />
        <Stat label="Inserts + removals"
              value={data ? data.totals.inserts + data.totals.deletes : (isLoading ? "…" : 0)}
              icon={AlertTriangle} tone="red"
              onClick={() => drill({ kind: "action-pair", actions: ["insert", "delete"] })} />
        <Stat label="Trainee changes (incl. list moves)"
              value={data?.totals.traineeListMoves ?? (isLoading ? "…" : 0)}
              icon={GraduationCap} tone="emerald"
              onClick={() => drill({ kind: "group", group: "trainee" })} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By staffing group</CardTitle>
          <CardDescription>
            Click any cell to drill into the matching events.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : groupRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No last-minute changes recorded in this range.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staffing group</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Inserts</TableHead>
                  <TableHead className="text-right">Moves / updates</TableHead>
                  <TableHead className="text-right">Removals</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupRows.map((r) => (
                  <TableRow key={r.group}>
                    <TableCell className="font-medium">
                      {GROUP_LABEL[r.group]}
                      {r.group === "trainee" && (
                        <Badge variant="outline" className="ml-2">tracks list moves</Badge>
                      )}
                    </TableCell>
                    <DrillCell value={r.total}
                      onClick={() => drill({ kind: "group", group: r.group })} />
                    <DrillCell value={r.inserts}
                      onClick={() => drill({ kind: "group-action", group: r.group, action: "insert" })} />
                    <DrillCell value={r.updates}
                      onClick={() => drill({ kind: "group-action", group: r.group, action: "update" })} />
                    <DrillCell value={r.deletes}
                      onClick={() => drill({ kind: "group-action", group: r.group, action: "delete" })} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card ref={drillRef}>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">
              {filter.kind === "none" ? "Drill-down" : describeFilter(filter)}
            </CardTitle>
            <CardDescription>
              {filter.kind === "none"
                ? "Click any total above to see the underlying change events here."
                : `${drillRows.length} event(s). Negative hours mean the change happened after the session had already started.`}
            </CardDescription>
          </div>
          {filter.kind !== "none" && (
            <Button variant="ghost" size="sm" onClick={() => setFilter({ kind: "none" })}>
              <X className="mr-1 h-4 w-4" /> Clear
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {filter.kind === "none" ? (
            <div className="text-sm text-muted-foreground">No filter selected.</div>
          ) : drillRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No matching events.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead>Scheduled start ({localTzAbbr()})</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Group</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>From → To list</TableHead>
                    <TableHead className="text-right">Hours before</TableHead>
                    <TableHead>Changed at ({localTzAbbr()})</TableHead>
                    <TableHead>Changed by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drillRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">
                        {formatDateGB(r.sessionDate)}{" "}
                        <span className="uppercase text-xs text-muted-foreground">{r.session}</span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatLocal(r.sessionStartTs)}
                      </TableCell>
                      <TableCell>
                        {r.action === "update" && r.prevStaffName && r.prevStaffName !== r.staffName ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="line-through text-muted-foreground">{r.prevStaffName}</span>
                            <ArrowRight className="h-3 w-3" />
                            <span>{r.staffName}</span>
                          </span>
                        ) : (
                          r.staffName
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.group === "trainee" ? "default" : "secondary"}>
                          {GROUP_LABEL[r.group]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className={cn(
                          "rounded px-2 py-0.5 text-xs font-medium",
                          r.action === "insert" && "bg-emerald-100 text-emerald-700",
                          r.action === "update" && "bg-amber-100 text-amber-700",
                          r.action === "delete" && "bg-red-100 text-red-700",
                        )}>
                          {r.action}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <ListMove from={r.fromList?.label ?? null} to={r.toList?.label ?? null} action={r.action} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {hoursBetween(r.changedAt, r.sessionStartTs).toFixed(1)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatLocal(r.changedAt)}
                      </TableCell>
                      <TableCell className="text-xs">{r.changedByName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Source: <code>rota_change_log</code>. The database trigger logs every
        insert, update or delete on a rota assignment whose session start is
        within ±48 hours of the change. All times shown in your local
        timezone (<code>{LOCAL_TZ}</code>, {localTzAbbr()}); &ldquo;hours
        before&rdquo; is the elapsed duration between the change and the
        scheduled session start.
      </p>
    </div>
  );
}

function DrillCell({ value, onClick }: { value: number; onClick: () => void }) {
  return (
    <TableCell className="text-right tabular-nums">
      {value === 0 ? (
        <span className="text-muted-foreground">0</span>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="rounded px-2 py-0.5 font-medium text-primary hover:bg-primary/10 hover:underline"
        >
          {value}
        </button>
      )}
    </TableCell>
  );
}

function ListMove({ from, to, action }: { from: string | null; to: string | null; action: string }) {
  if (!from && !to) return <span className="text-muted-foreground">—</span>;
  if (action === "insert") return <span><span className="text-muted-foreground">added to</span> {to ?? "—"}</span>;
  if (action === "delete") return <span><span className="text-muted-foreground">removed from</span> {from ?? "—"}</span>;
  if (from && to && from !== to) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="line-through text-muted-foreground">{from}</span>
        <ArrowRight className="h-3 w-3" />
        <span>{to}</span>
      </span>
    );
  }
  return <span>{to ?? from}</span>;
}

type StatProps = {
  label: string;
  value: number | string;
  icon: typeof Clock;
  tone: "amber" | "red" | "emerald" | "orange";
  onClick?: () => void;
};

function Stat({ label, value, icon: Icon, tone, onClick }: StatProps) {
  const toneClass =
    tone === "red" ? "bg-red-500/10 text-red-600"
    : tone === "amber" ? "bg-amber-500/10 text-amber-600"
    : tone === "orange" ? "bg-orange-500/10 text-orange-600"
    : "bg-emerald-500/10 text-emerald-600";
  const interactive = typeof value === "number" && value > 0 && !!onClick;
  return (
    <Card
      onClick={interactive ? onClick : undefined}
      className={cn(interactive && "cursor-pointer transition-colors hover:bg-accent/40")}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") onClick!(); } : undefined}
    >
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-md", toneClass)}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function parseISO(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, day ?? 1);
}
function toISO(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

type Preset = { label: string; range: () => { start: Date; end: Date } };

const PRESETS: Preset[] = [
  { label: "Last 7 days",   range: () => ({ start: subDays(new Date(), 6),  end: new Date() }) },
  { label: "Last 30 days",  range: () => ({ start: subDays(new Date(), 29), end: new Date() }) },
  { label: "Last 90 days",  range: () => ({ start: subDays(new Date(), 89), end: new Date() }) },
  { label: "This month",    range: () => ({ start: startOfMonth(new Date()), end: new Date() }) },
  { label: "Last month",    range: () => {
      const start = startOfMonth(subMonths(new Date(), 1));
      const end = subDays(startOfMonth(new Date()), 1);
      return { start, end };
    } },
  { label: "Year to date",  range: () => ({ start: startOfYear(new Date()), end: new Date() }) },
];

type DateRangeFilterProps = {
  rangeStart: string;
  rangeEnd: string;
  onChange: (start: string, end: string) => void;
};

function DateRangeFilter({ rangeStart, rangeEnd, onChange }: DateRangeFilterProps) {
  const range: DateRange = { from: parseISO(rangeStart), to: parseISO(rangeEnd) };
  const days = Math.max(
    1,
    Math.round(
      (parseISO(rangeEnd).getTime() - parseISO(rangeStart).getTime()) / 86_400_000,
    ) + 1,
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-[280px] justify-start text-left font-normal">
            <CalendarIcon className="mr-2 h-4 w-4" />
            {formatDateGB(rangeStart)} – {formatDateGB(rangeEnd)}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            numberOfMonths={2}
            defaultMonth={range.from}
            selected={range}
            onSelect={(next) => {
              if (next?.from && next?.to) onChange(toISO(next.from), toISO(next.to));
              else if (next?.from) onChange(toISO(next.from), toISO(next.from));
            }}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>

      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => {
          const { start, end } = p.range();
          const active = toISO(start) === rangeStart && toISO(end) === rangeEnd;
          return (
            <Button
              key={p.label}
              size="sm"
              variant={active ? "default" : "outline"}
              onClick={() => onChange(toISO(start), toISO(end))}
            >
              {p.label}
            </Button>
          );
        })}
      </div>

      <Badge variant="secondary" className="ml-auto">{days} day{days === 1 ? "" : "s"}</Badge>
    </div>
  );
}
