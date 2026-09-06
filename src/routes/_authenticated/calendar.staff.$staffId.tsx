import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Layers,
  Moon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/loading";
import { StatCard } from "@/components/stat-card";
import { StaffWeekView } from "@/components/rota-views";
import { CurrentPatternCard } from "@/components/current-pattern-card";
import { cn } from "@/lib/utils";
import {
  listSpecialtySessions,
  type SpecialtyPaRules,
  type SpecialtyRow,
  type SpecialtySession,
} from "@/features/analytics/specialty-workload";

export const Route = createFileRoute("/_authenticated/calendar/staff/$staffId")({
  head: () => ({
    meta: [
      { title: "Consultant rota calendar — Salisbury Anaesthetics Rota" },
      {
        name: "description",
        content:
          "Month-by-month view of a consultant's rota sessions, on-calls, weekend dates and CLWRota programmed activity values.",
      },
      { property: "og:title", content: "Consultant rota calendar" },
      {
        property: "og:description",
        content:
          "See every rota session, on-call and weekend date for a consultant, with recorded CLWRota PA values separated from estimates.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StaffCalendarPage,
});

const DEFAULT_RULES: SpecialtyPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};
const PAGE_SIZE = 1000;
const SESSION_ORDER: Record<string, number> = { am: 0, pm: 1, eve: 2, night: 3 };

type AssignmentRow = {
  staff_id: string | null;
  session_date: string | null;
  session: string | null;
  duty_type: string | null;
  extra_type: string | null;
  pa_credit: number | null;
  attending_consultant_ids: string[] | null;
  theatre_session_id: string | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  grade: string | null;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function monthStart(month: string) {
  return `${month}-01`;
}

function monthEnd(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function friendlyMonth(month: string) {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T12:00:00Z`));
}

function friendlyDay(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${iso}T12:00:00Z`));
}

function sessionLabel(session: string) {
  if (session === "am") return "AM";
  if (session === "pm") return "PM";
  if (session === "eve") return "Eve";
  if (session === "night") return "Night";
  return session || "Session";
}

function StaffCalendarPage() {
  const { staffId } = Route.useParams();
  const [month, setMonth] = useState(currentMonth);
  const start = monthStart(month);
  const end = monthEnd(month);

  const { data, isLoading, error } = useQuery({
    queryKey: ["staff-rota-calendar", staffId, start, end],
    queryFn: async () => {
      const [{ data: profiles, error: profilesError }, { data: rulesRow }] = await Promise.all([
        supabase.from("profiles").select("id,full_name,grade").order("full_name"),
        supabase
          .from("rota_rules")
          .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
          .limit(1)
          .maybeSingle(),
      ]);
      if (profilesError) throw profilesError;

      const rules: SpecialtyPaRules = {
        sessions_per_pa: Number(rulesRow?.sessions_per_pa ?? DEFAULT_RULES.sessions_per_pa),
        oncall_pa_credit: Number(rulesRow?.oncall_pa_credit ?? DEFAULT_RULES.oncall_pa_credit),
        weekend_pa_credit: Number(rulesRow?.weekend_pa_credit ?? DEFAULT_RULES.weekend_pa_credit),
      };

      const raw: AssignmentRow[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: page, error: assignmentsError } = await supabase
          .from("rota_assignments")
          .select(
            "staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids,theatre_session_id",
          )
          .gte("session_date", start)
          .lte("session_date", end)
          .range(from, from + PAGE_SIZE - 1);
        if (assignmentsError) throw assignmentsError;
        raw.push(...((page ?? []) as unknown as AssignmentRow[]));
        if (!page || page.length < PAGE_SIZE) break;
      }

      const sessionIds = Array.from(
        new Set(raw.map((r) => r.theatre_session_id).filter((v): v is string => Boolean(v))),
      );
      const specialtyBySession = new Map<string, string>();
      for (let i = 0; i < sessionIds.length; i += 300) {
        const { data: theatreSessions, error: sessionsError } = await supabase
          .from("theatre_sessions")
          .select("id,specialties(name)")
          .in("id", sessionIds.slice(i, i + 300));
        if (sessionsError) throw sessionsError;
        for (const row of (theatreSessions ?? []) as unknown as Array<{
          id: string;
          specialties: { name: string } | { name: string }[] | null;
        }>) {
          const specialty = Array.isArray(row.specialties) ? row.specialties[0] : row.specialties;
          if (specialty?.name) specialtyBySession.set(row.id, specialty.name);
        }
      }

      const rows: SpecialtyRow[] = raw.map((r) => ({
        staff_id: r.staff_id,
        session_date: r.session_date,
        session: r.session,
        duty_type: r.duty_type,
        extra_type: r.extra_type,
        pa_credit: r.pa_credit,
        attending_consultant_ids: r.attending_consultant_ids,
        specialty_name: r.theatre_session_id
          ? specialtyBySession.get(r.theatre_session_id) ?? null
          : null,
      }));

      return { profiles: (profiles ?? []) as ProfileRow[], rows, rules };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const nameById = new Map(data.profiles.map((p) => [p.id, p.full_name || "Unknown"]));
    const selected = data.profiles.find((p) => p.id === staffId);
    const sessions = listSpecialtySessions(data.rows, data.rules)
      .filter((s) => s.staff_id === staffId)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          (SESSION_ORDER[a.session] ?? 9) - (SESSION_ORDER[b.session] ?? 9) ||
          a.area.localeCompare(b.area),
      );

    const byDate = new Map<string, SpecialtySession[]>();
    const dates = new Set<string>();
    const onCallDates = new Set<string>();
    const weekendDates = new Set<string>();
    let recordedPas = 0;
    let estimatedPas = 0;

    for (const session of sessions) {
      const list = byDate.get(session.date) ?? [];
      list.push(session);
      byDate.set(session.date, list);
      dates.add(session.date);
      if (session.isOnCall) onCallDates.add(session.date);
      if (session.isWeekend) weekendDates.add(session.date);
      if (session.recordedPa !== null) recordedPas += session.creditedPa;
      else estimatedPas += session.creditedPa;
    }

    // Monday-first grid cells, including blanks before and after the month.
    const firstDow = new Date(`${start}T12:00:00Z`).getUTCDay();
    const leading = (firstDow + 6) % 7;
    const cells: Array<{ iso: string; inMonth: boolean }> = [];
    for (let i = leading; i > 0; i--) cells.push({ iso: addDaysIso(start, -i), inMonth: false });
    for (let d = start; d <= end; d = addDaysIso(d, 1)) cells.push({ iso: d, inMonth: true });
    while (cells.length % 7 !== 0) cells.push({ iso: addDaysIso(cells[cells.length - 1].iso, 1), inMonth: false });

    return {
      selected,
      nameById,
      byDate,
      cells,
      totals: {
        days: dates.size,
        sessions: sessions.filter((s) => !s.isOnCall).length,
        onCalls: onCallDates.size,
        weekendDays: weekendDates.size,
        recordedPas: round2(recordedPas),
        estimatedPas: round2(estimatedPas),
        totalPas: round2(recordedPas + estimatedPas),
      },
    };
  }, [data, end, staffId, start]);

  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link to="/calendar">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to global calendar
        </Link>
      </Button>

      <CurrentPatternCard staffId={staffId} />

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                {view?.selected?.full_name ?? "Staff member"} — rota calendar
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Sessions, on-calls and weekend dates for {friendlyMonth(month)}, with CLWRota-recorded
                PAs separated from rule estimates.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="staff-calendar-month">Month</Label>
                <Input
                  id="staff-calendar-month"
                  type="month"
                  value={month}
                  onChange={(e) => e.target.value && setMonth(e.target.value)}
                  className="w-[10.5rem]"
                />
              </div>
              <Button variant="outline" size="sm" onClick={() => setMonth(shiftMonth(month, -1))}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Previous
              </Button>
              <Button variant="outline" size="sm" onClick={() => setMonth(currentMonth())}>
                This month
              </Button>
              <Button variant="outline" size="sm" onClick={() => setMonth(shiftMonth(month, 1))}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive-muted p-3 text-sm text-destructive">
              Could not load this rota calendar: {error.message}
            </div>
          ) : null}

          {view ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Dates in work"
                  value={view.totals.days}
                  hint={`${view.totals.sessions} daytime sessions`}
                  icon={CalendarDays}
                />
                <StatCard
                  label="On-calls"
                  value={view.totals.onCalls}
                  hint="Counted once per date"
                  icon={Moon}
                  tone="info"
                />
                <StatCard
                  label="Weekend dates"
                  value={view.totals.weekendDays}
                  hint="Saturday or Sunday work"
                  icon={CalendarClock}
                  tone="warning"
                />
                <StatCard
                  label="Total PAs"
                  value={view.totals.totalPas}
                  hint={`${view.totals.recordedPas} recorded · ${view.totals.estimatedPas} estimated`}
                  icon={Layers}
                  tone={view.totals.estimatedPas > 0 ? "warning" : "success"}
                />
              </div>

              <div className="grid grid-cols-7 overflow-hidden rounded-xl border bg-card text-sm">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
                  <div
                    key={day}
                    className="border-b bg-muted px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {day}
                  </div>
                ))}
                {view.cells.map((cell) => {
                  const entries = view.byDate.get(cell.iso) ?? [];
                  const dayTotal = round2(entries.reduce((sum, s) => sum + s.creditedPa, 0));
                  const isWeekend = entries.some((s) => s.isWeekend) || [0, 6].includes(new Date(`${cell.iso}T12:00:00Z`).getUTCDay());
                  return (
                    <div
                      key={cell.iso}
                      className={cn(
                        "min-h-36 border-b border-r p-2 align-top [&:nth-child(7n)]:border-r-0",
                        !cell.inMonth && "bg-muted/40 text-muted-foreground",
                        cell.inMonth && isWeekend && "bg-warning-muted/40",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold">{Number(cell.iso.slice(8, 10))}</div>
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {friendlyDay(cell.iso).split(" ")[0]}
                          </div>
                        </div>
                        {entries.length > 0 ? (
                          <Badge variant={isWeekend ? "secondary" : "outline"} className="px-1.5 py-0 text-[10px]">
                            {dayTotal} PA
                          </Badge>
                        ) : null}
                      </div>

                      <div className="mt-2 space-y-1.5">
                        {entries.length === 0 && cell.inMonth ? (
                          <div className="text-xs text-muted-foreground">No rota work</div>
                        ) : null}
                        {entries.map((entry, index) => (
                          <div key={`${entry.date}-${entry.session}-${entry.area}-${index}`} className="rounded-md border bg-background p-1.5">
                            <div className="flex flex-wrap items-center gap-1">
                              <Badge variant={entry.isOnCall ? "secondary" : "outline"} className="px-1 py-0 text-[10px]">
                                {sessionLabel(entry.session)}
                              </Badge>
                              {entry.isOnCall ? <Badge className="px-1 py-0 text-[10px]">On-call</Badge> : null}
                              {entry.extraType ? (
                                <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                                  {entry.extraType}
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-1 line-clamp-2 text-xs font-medium leading-tight">{entry.area}</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {entry.recordedPa !== null
                                ? `CLWRota ${entry.recordedPa} PA`
                                : entry.creditedPa > 0
                                  ? `Estimated ${entry.creditedPa} PA`
                                  : "Credit counted elsewhere"}
                            </div>
                            {entry.sharedWith.length > 0 ? (
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                with {entry.sharedWith.map((id) => view.nameById.get(id) ?? "Unknown").join(", ")}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                “CLWRota PA” means the PA value stored on the imported CLWRota row. “Estimated” means
                CLWRota did not store a value, so the department rota rules were used. Weekend credit
                replaces the session or on-call credit rather than stacking on top of it.
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <StaffWeekView staffId={staffId} />
    </div>
  );
}
