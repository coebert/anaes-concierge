import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, CalendarRange, Stethoscope } from "lucide-react";
import { splitName } from "@/lib/utils";
import {
  LOCATION_LABELS,
  LOCATION_ORDER,
  suggestedRegularityThreshold,
  summariseStaff,
  WEEKDAY_LABELS,
  type AssignmentLite,
  type LocationBucket,
  type SessionLite,
  type SpecialtyLite,
  type StaffGrade,
  type StaffLite,
  type StaffSummary,
  type TheatreKind,
  type TheatreLite,
} from "@/lib/staff-working-patterns";
import {
  SpaStrip,
  WeekdayStrip,
  ROW_CLASS,
  ROW_LABEL_CLASS,
  STRIP_CLASS,
  CELL_CLASS,
} from "@/components/working-pattern-strips";

export const Route = createFileRoute("/_authenticated/staff/working-patterns")({
  head: () => ({ meta: [{ title: "Staff working patterns — Salisbury Anaesthetics Rota" }] }),
  component: WorkingPatternsPage,
});

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type GradeFilter = "all" | StaffGrade;

function WorkingPatternsPage() {
  const [windowDays, setWindowDays] = useState<number>(180);
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [filter, setFilter] = useState("");

  const from = useMemo(() => isoDaysAgo(windowDays), [windowDays]);
  const to = todayIso();

  const { data, isLoading, error } = useQuery({
    queryKey: ["staff-working-patterns", from, to],
    queryFn: async () => {
      // Active anaesthetic staff. We use the plain profiles table (no
      // decrypt RPC needed — full_name is not encrypted) so this page
      // is safe for coordinators and admins alike.
      const { data: profiles, error: pe } = await supabase
        .from("profiles")
        .select("id, full_name, grade, active, left_at")
        .eq("active", true);
      if (pe) throw pe;
      const staff: StaffLite[] = (profiles ?? [])
        .filter((p) => !p.left_at)
        .map((p) => ({
          id: p.id,
          full_name: (p.full_name ?? "").trim() || "(unnamed)",
          grade: (p.grade ?? null) as StaffGrade | null,
        }))
        .sort((a, b) => a.full_name.localeCompare(b.full_name));

      const { data: theatres, error: te } = await supabase
        .from("theatres")
        .select("id, name, kind");
      if (te) throw te;
      const theatresById = new Map<string, TheatreLite>();
      for (const t of theatres ?? []) {
        theatresById.set(t.id, {
          id: t.id,
          name: t.name,
          kind: (t.kind ?? null) as TheatreKind | null,
        });
      }

      const { data: specialties, error: se } = await supabase
        .from("specialties")
        .select("id, name");
      if (se) throw se;
      const specialtiesById = new Map<string, SpecialtyLite>();
      for (const s of specialties ?? []) {
        specialtiesById.set(s.id, { id: s.id, name: s.name });
      }

      // Theatre sessions in the window — paginated to work around the
      // Data API's 1000-row default cap.
      const sessionsById = new Map<string, SessionLite>();
      {
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          const { data: page, error: err } = await supabase
            .from("theatre_sessions")
            .select("id, theatre_id, specialty_id, is_non_sag, session_date")
            .gte("session_date", from)
            .lte("session_date", to)
            .range(offset, offset + PAGE - 1);
          if (err) throw err;
          const rows = page ?? [];
          for (const r of rows) {
            sessionsById.set(r.id, {
              id: r.id,
              theatre_id: r.theatre_id ?? null,
              specialty_id: r.specialty_id ?? null,
              is_non_sag: r.is_non_sag ?? false,
            });
          }
          if (rows.length < PAGE) break;
          offset += PAGE;
        }
      }

      const assignments: AssignmentLite[] = [];
      {
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          const { data: page, error: err } = await supabase
            .from("rota_assignments")
            .select("staff_id, duty_type, theatre_session_id, session_date, session")
            .gte("session_date", from)
            .lte("session_date", to)
            .range(offset, offset + PAGE - 1);
          if (err) throw err;
          const rows = page ?? [];
          for (const r of rows) {
            assignments.push({
              staff_id: r.staff_id,
              duty_type: r.duty_type ?? null,
              session_date: r.session_date,
              session: r.session ?? null,
              theatre_session_id: r.theatre_session_id ?? null,
            });
          }
          if (rows.length < PAGE) break;
          offset += PAGE;
        }
      }

      const summaries = summariseStaff(
        staff,
        assignments,
        sessionsById,
        theatresById,
        specialtiesById,
        { regularityThreshold: suggestedRegularityThreshold(windowDays) },
      );
      return { summaries, windowDays };
    },
  });

  const filtered = useMemo(() => {
    const rows = data?.summaries ?? [];
    const q = filter.trim().toLowerCase();
    return rows
      .filter((r) => (gradeFilter === "all" ? true : r.grade === gradeFilter))
      .filter((r) => (q ? r.full_name.toLowerCase().includes(q) : true))
      .sort((a, b) => {
        // Consultants first (working-pattern is most detailed), then SAS,
        // then trainees. Within a grade, sort by surname.
        const gradeOrder = (g: StaffGrade | null) =>
          g === "consultant" ? 0 : g === "sas" ? 1 : g === "trainee" ? 2 : 3;
        return (
          gradeOrder(a.grade) - gradeOrder(b.grade) ||
          (splitName(a.full_name).surname ?? "").localeCompare(
            splitName(b.full_name).surname ?? "",
          ) || a.full_name.localeCompare(b.full_name)
        );
      });
  }, [data, filter, gradeFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Working patterns
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          For each anaesthetic staff member, a summary of the lists they
          cover — split by day surgery, main theatres, NHH (private/SAG),
          obstetrics and ICU — plus the specialties they most often work
          with. For consultants, we derive the normal weekly working
          pattern, private (SAG) days and on-call profile from the recent
          rota history.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Regularity threshold auto-adjusts to the window (roughly one
            session per four weeks).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="window">Window</Label>
              <Select
                value={String(windowDays)}
                onValueChange={(v) => setWindowDays(Number(v))}
              >
                <SelectTrigger id="window" className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="90">Last 90 days</SelectItem>
                  <SelectItem value="180">Last 180 days</SelectItem>
                  <SelectItem value="365">Last 12 months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="grade">Grade</Label>
              <Select
                value={gradeFilter}
                onValueChange={(v) => setGradeFilter(v as GradeFilter)}
              >
                <SelectTrigger id="grade" className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All grades</SelectItem>
                  <SelectItem value="consultant">Consultants</SelectItem>
                  <SelectItem value="sas">SAS</SelectItem>
                  <SelectItem value="trainee">Trainees</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 min-w-[220px] flex-1">
              <Label htmlFor="search">Search</Label>
              <Input
                id="search"
                placeholder="Filter by name…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">
          Loading rota history and computing patterns…
        </p>
      ) : error ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">
            Failed to load working patterns: {(error as Error).message}
          </CardContent>
        </Card>
      ) : !filtered.length ? (
        <p className="text-sm text-muted-foreground">No staff match the filters.</p>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((r) => (
            <StaffCard key={r.staff_id} summary={r} windowDays={windowDays} />
          ))}
        </div>
      )}
    </div>
  );
}

function StaffCard({
  summary,
  windowDays,
}: {
  summary: StaffSummary;
  windowDays: number;
}) {
  const totalByLoc = LOCATION_ORDER.reduce(
    (acc, k) => acc + summary.byLocation[k],
    0,
  );

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            {summary.grade === "consultant" ? (
              <Stethoscope className="h-4 w-4" />
            ) : (
              <Users className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base leading-tight truncate">
              {summary.full_name}
            </CardTitle>
            <CardDescription className="text-xs capitalize">
              {summary.grade ?? "unknown"} · {summary.totalSessions} session
              {summary.totalSessions === 1 ? "" : "s"} in last {windowDays}d
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <LocationBreakdown byLocation={summary.byLocation} total={totalByLoc} />
        <SpecialtyList bySpecialty={summary.bySpecialty} />
        {summary.consultantPattern && (
          <ConsultantPatternBlock pattern={summary.consultantPattern} />
        )}
      </CardContent>
    </Card>
  );
}

function LocationBreakdown({
  byLocation,
  total,
}: {
  byLocation: Record<LocationBucket, number>;
  total: number;
}) {
  const rows = LOCATION_ORDER.filter((k) => byLocation[k] > 0);
  if (!rows.length) {
    return (
      <p className="text-xs text-muted-foreground">
        No rota sessions in this window.
      </p>
    );
  }
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">
        Lists by location
      </div>
      <div className="space-y-1">
        {rows.map((k) => {
          const count = byLocation[k];
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <div key={k} className="flex items-center gap-2 text-xs">
              <div className="w-40 shrink-0 truncate">{LOCATION_LABELS[k]}</div>
              <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary/70"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="w-16 text-right tabular-nums text-muted-foreground">
                {count} ({pct}%)
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SpecialtyList({
  bySpecialty,
}: {
  bySpecialty: Array<{ specialty: string; count: number }>;
}) {
  if (!bySpecialty.length) return null;
  const top = bySpecialty.slice(0, 6);
  const rest = bySpecialty.length - top.length;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">
        Top specialties
      </div>
      <div className="flex flex-wrap gap-1">
        {top.map((s) => (
          <Badge key={s.specialty} variant="secondary" className="text-[11px]">
            {s.specialty} · {s.count}
          </Badge>
        ))}
        {rest > 0 && (
          <Badge variant="outline" className="text-[11px]">
            +{rest} more
          </Badge>
        )}
      </div>
    </div>
  );
}

function ConsultantPatternBlock({
  pattern,
}: {
  pattern: NonNullable<StaffSummary["consultantPattern"]>;
}) {
  const onCallLabel =
    pattern.onCallType === "both"
      ? "Theatre + ICU"
      : pattern.onCallType === "theatre"
        ? "Theatre / general"
        : pattern.onCallType === "icu"
          ? "ICU only"
          : "No on-call recorded";

  const amSet = new Set(pattern.amWorkingWeekdays);
  const pmSet = new Set(pattern.pmWorkingWeekdays);
  const hasAnySpa =
    pattern.spaAmWeekdays.length > 0 || pattern.spaPmWeekdays.length > 0;

  return (
    <div className="border-t pt-3 space-y-1.5">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <CalendarRange className="h-3.5 w-3.5" />
        <span>Normal working pattern</span>
      </div>
      <WeekdayHeader />
      <AmPmStrip amSet={amSet} pmSet={pmSet} />
      <WeekdayStrip
        label="Private / SAG"
        highlighted={pattern.privateWeekdays}
        tone="primary"
      />
      <SpaStrip
        amDays={pattern.spaAmWeekdays}
        pmDays={pattern.spaPmWeekdays}
        countsByWeekday={pattern.spaCountsByWeekday}
        totalSessions={pattern.totalSpaSessions}
      />
      {!hasAnySpa && (
        <p className="text-[11px] text-muted-foreground pl-[5.5rem] sm:pl-[6.5rem] -mt-1">
          No regular SPA slot identified in this window.
        </p>
      )}
      <WeekdayStrip
        label="On-call"
        highlighted={pattern.onCallWeekdays}
        tone="amber"
        countsByWeekday={pattern.onCallCountsByWeekday}
        totalSessions={pattern.totalOnCallSessions}
      />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1">
        <span>On-call cover</span>
        <Badge variant="outline" className="text-[11px]">
          {onCallLabel}
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Weekdays counted as regular when they appear on at least{" "}
        {pattern.regularityThreshold} distinct dates in the window. AM/PM
        shading shows whether the consultant typically works the morning,
        afternoon, or both.
      </p>
    </div>
  );
}

// Shared column geometry so every row aligns under the same day columns.
// Label has a fixed width; the 5 weekday cells share the remaining card
// width equally so the grid always fits inside its card, on every
// breakpoint. All rows use the same wrappers so cells line up.
const ROW_CLASS = "flex items-center gap-2 text-xs";
// Narrow (mobile / 3-col xl grid) → shorter label; sm+ → full width.
// `truncate` is a safety net so unexpected long labels can't stretch the row.
const ROW_LABEL_CLASS =
  "w-20 sm:w-24 shrink-0 truncate text-muted-foreground";
const STRIP_CLASS = "flex flex-1 min-w-0 gap-1";
// `overflow-hidden` lets cell text clip gracefully if a cell is squeezed
// below its intrinsic content width on very narrow cards.
const CELL_CLASS = "flex-1 min-w-0 overflow-hidden";

function WeekdayHeader() {
  return (
    <div className={ROW_CLASS}>
      <div className={ROW_LABEL_CLASS} />
      <div className={STRIP_CLASS}>
        {[1, 2, 3, 4, 5].map((d) => (
          <div
            key={d}
            className={
              CELL_CLASS +
              " text-center text-[10px] font-medium text-muted-foreground"
            }
          >
            {WEEKDAY_LABELS[d].slice(0, 3)}
          </div>
        ))}
      </div>
    </div>
  );
}

function AmPmStrip({
  amSet,
  pmSet,
}: {
  amSet: Set<number>;
  pmSet: Set<number>;
}) {
  const halfCell =
    "flex h-4 items-center justify-center text-[9px] font-medium border";
  return (
    <div className={ROW_CLASS}>
      <div className={ROW_LABEL_CLASS}>Working</div>
      <div className={STRIP_CLASS}>
        {[1, 2, 3, 4, 5].map((d) => {
          const am = amSet.has(d);
          const pm = pmSet.has(d);
          return (
            <div
              key={d}
              className={CELL_CLASS + " flex flex-col"}
              title={WEEKDAY_LABELS[d]}
            >
              <div
                className={
                  halfCell +
                  " rounded-t " +
                  (am
                    ? "bg-foreground text-background border-foreground"
                    : "border-border bg-muted/40 text-muted-foreground")
                }
              >
                {am ? "AM" : ""}
              </div>
              <div
                className={
                  halfCell +
                  " rounded-b border-t-0 " +
                  (pm
                    ? "bg-foreground/80 text-background border-foreground"
                    : "border-border bg-muted/40 text-muted-foreground")
                }
              >
                {pm ? "PM" : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SpaStrip({
  amDays,
  pmDays,
  countsByWeekday,
  totalSessions,
}: {
  amDays: number[];
  pmDays: number[];
  countsByWeekday: number[];
  totalSessions: number;
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
          const pct =
            active && totalSessions > 0
              ? Math.round((countsByWeekday[d] / totalSessions) * 100)
              : null;
          return (
            <div
              key={d}
              className={
                CELL_CLASS +
                " flex flex-col items-center justify-center rounded border text-[10px] font-medium leading-none px-0.5 " +
                (pct !== null ? "py-0.5" : "h-6") +
                " " +
                (active
                  ? "bg-sky-600 text-white border-sky-600 dark:bg-sky-500 dark:border-sky-500"
                  : "border-border bg-muted/40 text-muted-foreground")
              }
              title={
                `${WEEKDAY_LABELS[d]}` +
                (active
                  ? ` · SPA ${label} · ${countsByWeekday[d]} of ${totalSessions} SPA sessions (${pct}%)`
                  : "")
              }
            >
              <span>{label}</span>
              {pct !== null && (
                <span className="text-[9px] font-normal opacity-90 tabular-nums">
                  {pct}%
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekdayStrip({
  label,
  highlighted,
  tone = "default",
  countsByWeekday,
  totalSessions,
}: {
  label: string;
  highlighted: number[];
  tone?: "default" | "primary" | "amber";
  countsByWeekday?: number[];
  totalSessions?: number;
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
          const pct =
            active && countsByWeekday && totalSessions && totalSessions > 0
              ? Math.round((countsByWeekday[d] / totalSessions) * 100)
              : null;
          return (
            <div
              key={d}
              className={
                CELL_CLASS +
                " flex flex-col items-center justify-center rounded border text-[11px] font-medium leading-none px-0.5 " +
                (pct !== null ? "py-0.5" : "h-6") +
                " " +
                (active
                  ? highlightClass
                  : "border-border bg-muted/40 text-muted-foreground")
              }
              title={
                WEEKDAY_LABELS[d] +
                (pct !== null
                  ? ` · ${countsByWeekday![d]} of ${totalSessions} ${label.toLowerCase()} sessions (${pct}%)`
                  : "")
              }
            >
              <span>{active ? WEEKDAY_LABELS[d].slice(0, 3) : "–"}</span>
              {pct !== null && (
                <span className="text-[9px] font-normal opacity-90 tabular-nums">
                  {pct}%
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
