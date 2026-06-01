import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShieldAlert, UserMinus, GraduationCap, MapPin, Info, ListChecks } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { computeRobustness, computeListCoverage, riskColor, riskLabel } from "@/lib/audit/robustness";
import { todayISO, addDaysISO, formatDateGB, cn } from "@/lib/utils";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shortDay(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}`;
}

function worstRisk(a: "ok" | "tight" | "shortfall" | "spa_required", b: "ok" | "tight" | "shortfall" | "spa_required") {
  const order = { ok: 0, tight: 1, spa_required: 2, shortfall: 3 } as const;
  return order[a] >= order[b] ? a : b;
}

export function SummaryDashboard() {
  const today = todayISO();
  const in6 = addDaysISO(6);

  const { data: robustness, isLoading: rLoading } = useQuery({
    queryKey: ["summary-robustness", today, in6],
    queryFn: () => computeRobustness(today, in6),
  });

  const { data: leaveToday, isLoading: lLoading } = useQuery({
    queryKey: ["summary-leave-today", today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leave_requests")
        .select("id,type,staff_id,profiles!leave_requests_staff_id_fkey!inner(full_name,grade)")
        .eq("status", "approved")
        .lte("start_date", today)
        .gte("end_date", today);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; type: string; staff_id: string;
        profiles: { full_name: string; grade: string | null };
      }>;
    },
  });

  const { data: soloToday, isLoading: sLoading } = useQuery({
    queryKey: ["summary-solo-trainees-today", today],
    queryFn: async () => {
      const { data: assigns, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,theatre_session_id,profiles!rota_assignments_staff_id_fkey!inner(full_name,grade,training_level)")
        .eq("session_date", today)
        .eq("role_on_list", "solo")
        .eq("duty_type", "theatre")
        .eq("profiles.grade", "trainee");
      if (error) throw error;
      const rows = (assigns ?? []) as Array<{
        id: string; staff_id: string; theatre_session_id: string | null;
        profiles: { full_name: string; grade: string; training_level: string | null };
      }>;
      const tsIds = Array.from(new Set(rows.map((r) => r.theatre_session_id).filter(Boolean) as string[]));
      const theatreById = new Map<string, string>();
      if (tsIds.length > 0) {
        const { data: ts } = await supabase
          .from("theatre_sessions")
          .select("id,theatre_id,theatres!inner(name)")
          .in("id", tsIds);
        for (const r of (ts ?? []) as Array<{ id: string; theatres: { name: string } }>) {
          theatreById.set(r.id, r.theatres.name);
        }
      }
      return rows.map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        name: r.profiles.full_name,
        trainingLevel: r.profiles.training_level,
        theatre: r.theatre_session_id ? theatreById.get(r.theatre_session_id) ?? "Unknown theatre" : "Unassigned theatre",
      }));
    },
  });

  // Leave breakdown
  const leaveByGrade = (leaveToday ?? []).reduce(
    (acc, r) => {
      const isConsultant = r.profiles.grade === "consultant";
      const isTrainee = r.profiles.grade === "trainee";
      if (!isConsultant && !isTrainee) return acc;
      const bucket = isConsultant ? acc.consultants : acc.trainees;
      bucket.total += 1;
      bucket.byType[r.type] = (bucket.byType[r.type] ?? 0) + 1;
      bucket.entries.push({ name: r.profiles.full_name, type: r.type });
      return acc;
    },
    {
      consultants: { total: 0, byType: {} as Record<string, number>, entries: [] as Array<{ name: string; type: string }> },
      trainees: { total: 0, byType: {} as Record<string, number>, entries: [] as Array<{ name: string; type: string }> },
    },
  );

  const { data: listCoverage, isLoading: cLoading } = useQuery({
    queryKey: ["summary-list-coverage", today, in6],
    queryFn: () => computeListCoverage(today, in6),
  });

  const days = robustness?.days ?? [];

  return (
    <TooltipProvider>
      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Today &amp; the week ahead
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Robustness — next 7 days */}
          <Card className="lg:col-span-3">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-primary" />
                Rota robustness — next 7 days
              </CardTitle>
              <CardDescription>
                Worst-half risk per day. Click a day to drill down.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : days.length === 0 ? (
                <div className="text-sm text-muted-foreground">No weekdays in the next 7 days.</div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {days.map((d) => {
                      const risk = worstRisk(d.am.risk, d.pm.risk);
                      const headroom = Math.min(d.am.headroom, d.pm.headroom);
                      return (
                        <Tooltip key={d.date}>
                          <TooltipTrigger asChild>
                            <Link
                              to="/robustness/day/$date"
                              params={{ date: d.date }}
                              className={cn(
                                "flex min-w-[5.5rem] flex-col items-center rounded-md border px-3 py-2 text-xs transition-colors hover:border-primary/60",
                                riskColor(risk),
                              )}
                            >
                              <span className="font-medium">{shortDay(d.date)}</span>
                              <span className="text-[10px] opacity-80">headroom {headroom}</span>
                              <span className="text-[10px] opacity-80">{riskLabel(risk)}</span>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p className="text-xs">
                              {formatDateGB(d.date)}<br />
                              AM: {riskLabel(d.am.risk)} (headroom {d.am.headroom}, {d.am.unfilled} unfilled)<br />
                              PM: {riskLabel(d.pm.risk)} (headroom {d.pm.headroom}, {d.pm.unfilled} unfilled)
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                  <RobustnessLegend />
                </>
              )}
            </CardContent>
          </Card>

          {/* Consultants on leave today */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <UserMinus className="h-4 w-4 text-orange-600" />
                Consultants on leave today
                <Badge variant="secondary" className="ml-auto">{leaveByGrade.consultants.total}</Badge>
              </CardTitle>
              <CardDescription>Approved leave covering {formatDateGB(today)}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {lLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : leaveByGrade.consultants.total === 0 ? (
                <div className="text-sm text-muted-foreground">No consultants on leave today.</div>
              ) : (
                <>
                  <LeaveTypeBreakdown byType={leaveByGrade.consultants.byType} />
                  <LeaveNameList entries={leaveByGrade.consultants.entries} />
                </>
              )}
            </CardContent>
          </Card>

          {/* Trainees on leave today */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <UserMinus className="h-4 w-4 text-sky-600" />
                Trainees on leave today
                <Badge variant="secondary" className="ml-auto">{leaveByGrade.trainees.total}</Badge>
              </CardTitle>
              <CardDescription>Approved leave covering {formatDateGB(today)}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {lLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : leaveByGrade.trainees.total === 0 ? (
                <div className="text-sm text-muted-foreground">No trainees on leave today.</div>
              ) : (
                <>
                  <LeaveTypeBreakdown byType={leaveByGrade.trainees.byType} />
                  <LeaveNameList entries={leaveByGrade.trainees.entries} />
                </>
              )}
            </CardContent>
          </Card>

          {/* Solo trainees today */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <GraduationCap className="h-4 w-4 text-amber-600" />
                Solo trainees today
                <Badge variant="secondary" className="ml-auto">{soloToday?.length ?? 0}</Badge>
              </CardTitle>
              <CardDescription>Trainee assigned as solo on a theatre list.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {sLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : (soloToday?.length ?? 0) === 0 ? (
                <div className="text-sm text-muted-foreground">No solo trainees today.</div>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {soloToday!.map((s) => (
                    <li key={s.id} className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <div className="flex-1">
                        <div className="font-medium">{s.theatre}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.name}{s.trainingLevel ? ` · ${s.trainingLevel}` : ""}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </TooltipProvider>
  );
}

function LegendSwatch({ color, label, description }: { color: string; label: string; description: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className={cn("mt-0.5 inline-block h-3 w-3 shrink-0 rounded-sm", color)} />
      <div className="leading-tight">
        <span className="text-xs font-medium">{label}</span>
        <p className="text-[10px] text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function RobustnessLegend() {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Info className="h-3.5 w-3.5" />
        How rota robustness is calculated
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground leading-relaxed">
        Robustness compares solo-capable staff (consultants + senior trainees ST6–ST8 who are free) against unfilled theatre lists. Junior trainees and SAS doctors are tracked but do not count toward solo cover. Each day shows the worst half (AM or PM).
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        <LegendSwatch
          color="bg-emerald-300/50"
          label="OK"
          description="Comfortable headroom (>1 spare solo-capable person)."
        />
        <LegendSwatch
          color="bg-amber-400/80"
          label="Tight"
          description="Covered, but headroom is 0 or 1."
        />
        <LegendSwatch
          color="bg-orange-400/80"
          label="SPA needed"
          description="Shortfall closes only by pulling a consultant off SPA time."
        />
        <LegendSwatch
          color="bg-red-500/80"
          label="Shortfall"
          description="Not enough solo-capable staff even after redeploying SPA."
        />
      </div>
    </div>
  );
}

function LeaveTypeBreakdown({ byType }: { byType: Record<string, number> }) {
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([type, count]) => (
        <Badge key={type} variant="outline" className="text-[10px] capitalize">
          {type.replace(/_/g, " ")}: {count}
        </Badge>
      ))}
    </div>
  );
}

function LeaveNameList({ entries }: { entries: Array<{ name: string; type: string }> }) {
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      {entries.map((e, i) => (
        <li key={i} className="flex items-center justify-between gap-2">
          <span className="text-foreground">{e.name}</span>
          <span className="capitalize">{e.type.replace(/_/g, " ")}</span>
        </li>
      ))}
    </ul>
  );
}
