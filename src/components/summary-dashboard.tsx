import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShieldAlert, UserMinus, GraduationCap, MapPin, Info, ListChecks, CalendarOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { computeRobustness, computeListCoverage, riskColor, riskLabel } from "@/lib/audit/robustness";
import { todayISO, addDaysISO, formatDateGB, cn, compareBySurname } from "@/lib/name-sort";

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
        .eq("profiles.grade", "trainee")
        .not("theatre_session_id", "is", null);
      if (error) throw error;
      const rows = (assigns ?? []) as Array<{
        id: string; staff_id: string; theatre_session_id: string | null;
        profiles: { full_name: string; grade: string; training_level: string | null };
      }>;
      const tsIds = Array.from(new Set(rows.map((r) => r.theatre_session_id).filter(Boolean) as string[]));
      const theatreById = new Map<string, string>();
      const consultantSessionIds = new Set<string>();
      if (tsIds.length > 0) {
        const { data: ts } = await supabase
          .from("theatre_sessions")
          .select("id,theatre_id,theatres!inner(name)")
          .in("id", tsIds);
        for (const r of (ts ?? []) as Array<{ id: string; theatres: { name: string } }>) {
          theatreById.set(r.id, r.theatres.name);
        }
        // Exclude sessions that also have a consultant or SAS doctor assigned —
        // those trainees are working alongside a senior career-grade doctor,
        // so they aren't truly solo / unsupervised.
        const { data: coAssigns } = await supabase
          .from("rota_assignments")
          .select("theatre_session_id,profiles!rota_assignments_staff_id_fkey!inner(grade)")
          .eq("session_date", today)
          .eq("duty_type", "theatre")
          .in("theatre_session_id", tsIds)
          .in("profiles.grade", ["consultant", "sas"]);
        for (const r of (coAssigns ?? []) as Array<{ theatre_session_id: string | null }>) {
          if (r.theatre_session_id) consultantSessionIds.add(r.theatre_session_id);
        }

      }
      return rows
        .filter((r) => r.theatre_session_id && !consultantSessionIds.has(r.theatre_session_id))
        .map((r) => ({
          id: r.id,
          staffId: r.staff_id,
          name: r.profiles.full_name,
          trainingLevel: r.profiles.training_level,
          theatre: theatreById.get(r.theatre_session_id!) ?? "Unknown theatre",
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

  // Staff who are NOT scheduled to work today — no rota assignment at all,
  // not on approved leave, and not on an LTFT contractual day off. SPA/admin
  // (and every other duty_type) counts as "scheduled", so those people are
  // intentionally excluded from these lists.
  const { data: notWorking, isLoading: nwLoading } = useQuery({
    queryKey: ["summary-not-working-today", today],
    queryFn: async () => {
      const [staffRes, assignRes, leaveRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id,full_name,grade,training_level,ltft_days_off,rotation_end_date")
          .eq("active", true)
          .in("grade", ["consultant", "sas", "trainee"]),
        supabase
          .from("rota_assignments")
          .select("staff_id")
          .eq("session_date", today),
        supabase
          .from("leave_requests")
          .select("staff_id")
          .eq("status", "approved")
          .lte("start_date", today)
          .gte("end_date", today),
      ]);
      if (staffRes.error) throw staffRes.error;
      if (assignRes.error) throw assignRes.error;
      if (leaveRes.error) throw leaveRes.error;

      const assignedIds = new Set((assignRes.data ?? []).map((a) => a.staff_id));
      const leaveIds = new Set((leaveRes.data ?? []).map((l) => l.staff_id));
      // Match the rota's Mon-first day-of-week convention used by
      // ltft_days_off (see rota-validation.ts:dayIndexMonFirst).
      const js = new Date(today + "T00:00:00").getDay();
      const dowMonFirst = (js + 6) % 7;

      type Entry = { id: string; name: string; trainingLevel: string | null };
      const buckets: { consultants: Entry[]; sas: Entry[]; trainees: Entry[] } = {
        consultants: [],
        sas: [],
        trainees: [],
      };

      const rows = (staffRes.data ?? []) as Array<{
        id: string;
        full_name: string;
        grade: string | null;
        training_level: string | null;
        ltft_days_off: number[] | null;
        rotation_end_date: string | null;
      }>;
      for (const p of rows) {
        if (assignedIds.has(p.id)) continue;
        if (leaveIds.has(p.id)) continue;
        if ((p.ltft_days_off ?? []).includes(dowMonFirst)) continue;
        // Trainees past their rotation end date have left the department.
        if (p.grade === "trainee" && p.rotation_end_date && today > p.rotation_end_date) continue;
        const entry: Entry = { id: p.id, name: p.full_name, trainingLevel: p.training_level };
        if (p.grade === "consultant") buckets.consultants.push(entry);
        else if (p.grade === "sas") buckets.sas.push(entry);
        else if (p.grade === "trainee") buckets.trainees.push(entry);
      }
      for (const k of ["consultants", "sas", "trainees"] as const) {
        buckets[k].sort((a, b) => compareBySurname(a.name, b.name));
      }
      return buckets;
    },
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

          {/* Not scheduled today — consultants / SAS / trainees with no rota
              entry at all, excluding leave and LTFT contractual days off.
              SPA/admin counts as scheduled, so those people don't appear. */}
          <NotScheduledCard
            title="Consultants not scheduled today"
            tone="text-emerald-600"
            loading={nwLoading}
            entries={notWorking?.consultants ?? []}
            today={today}
            showLevel={false}
          />
          <NotScheduledCard
            title="SAS not scheduled today"
            tone="text-indigo-600"
            loading={nwLoading}
            entries={notWorking?.sas ?? []}
            today={today}
            showLevel={false}
          />
          <NotScheduledCard
            title="Trainees not scheduled today"
            tone="text-fuchsia-600"
            loading={nwLoading}
            entries={notWorking?.trainees ?? []}
            today={today}
            showLevel
          />
        </div>

        {/* Per-day list coverage breakdown */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-primary" />
              List coverage breakdown — next 7 days
            </CardTitle>
            <CardDescription>
              Per-day totals of lists with solo-capable cover, unfilled lists, and SPA-needed sessions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {cLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : (listCoverage?.length ?? 0) === 0 ? (
              <div className="text-sm text-muted-foreground">No data for the next 7 days.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Day</th>
                      <th className="pb-2 pr-4 font-medium text-right">Lists</th>
                      <th className="pb-2 pr-4 font-medium text-right">Solo-capable</th>
                      <th className="pb-2 pr-4 font-medium text-right">Unfilled</th>
                      <th className="pb-2 font-medium">SPA needed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {listCoverage!.map((d) => {
                      const totalLists = d.am.total + d.pm.total;
                      const totalSolo = d.am.soloCapable + d.pm.soloCapable;
                      const totalUnfilled = d.am.unfilled + d.pm.unfilled;
                      const spaHalves: string[] = [];
                      if (d.am.spaNeeded) spaHalves.push("AM");
                      if (d.pm.spaNeeded) spaHalves.push("PM");
                      return (
                        <tr key={d.date}>
                          <td className="py-2 pr-4">
                            <Link
                              to="/robustness/day/$date"
                              params={{ date: d.date }}
                              className="font-medium hover:underline"
                            >
                              {shortDay(d.date)}
                            </Link>
                          </td>
                          <td className="py-2 pr-4 text-right">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help">{totalLists}</span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <p className="text-xs">
                                  AM: {d.am.total} lists<br />
                                  PM: {d.pm.total} lists
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </td>
                          <td className="py-2 pr-4 text-right">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className={cn("cursor-help", totalSolo < totalLists - totalUnfilled && "text-amber-600 font-medium")}>
                                  {totalSolo}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <p className="text-xs">
                                  AM: {d.am.soloCapable} solo-capable<br />
                                  PM: {d.pm.soloCapable} solo-capable
                                  {(d.am.supervised + d.pm.supervised) > 0 && (
                                    <><br />Total supervised: {d.am.supervised + d.pm.supervised}</>
                                  )}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </td>
                          <td className="py-2 pr-4 text-right">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className={cn("cursor-help", totalUnfilled > 0 && "text-red-600 font-medium")}>
                                  {totalUnfilled}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <p className="text-xs">
                                  AM: {d.am.unfilled} unfilled<br />
                                  PM: {d.pm.unfilled} unfilled
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </td>
                          <td className="py-2">
                            {spaHalves.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {spaHalves.map((h) => (
                                  <Badge key={h} variant="outline" className="text-[10px] border-orange-400/60 text-orange-700 bg-orange-50 dark:bg-orange-950/30">
                                    {h} SPA needed
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
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

function NotScheduledCard({
  title,
  tone,
  loading,
  entries,
  today,
  showLevel,
}: {
  title: string;
  tone: string;
  loading: boolean;
  entries: Array<{ id: string; name: string; trainingLevel: string | null }>;
  today: string;
  showLevel: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarOff className={cn("h-4 w-4", tone)} />
          {title}
          <Badge variant="secondary" className="ml-auto">{entries.length}</Badge>
        </CardTitle>
        <CardDescription>
          No rota entry for {formatDateGB(today)} (SPA/admin excluded).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-muted-foreground">Everyone is scheduled today.</div>
        ) : (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <span className="text-foreground">{e.name}</span>
                {showLevel && e.trainingLevel ? (
                  <span className="capitalize">{e.trainingLevel}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
