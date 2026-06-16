import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  listActiveStaffSafe,
  listStaffByIdsSafe,
} from "@/lib/staff-directory.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  User,
} from "lucide-react";
import { cn, parseDateLocal, toISODateLocal } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";

type SessionHalf = "am" | "pm";

export function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}
export function iso(d: Date) { return toISODateLocal(d); }
export function fmt(d: Date) {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export type ViewMode = "day" | "week" | "month";

/**
 * Small pill used to mark AM / PM session columns and labels.
 * Distinct tones for AM (sky) vs PM (indigo) help scanning the grid quickly.
 */
export function SessionChip({
  half,
  active = false,
  className,
}: {
  half: "am" | "pm";
  active?: boolean;
  className?: string;
}) {
  const isAm = half === "am";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] tabular-nums transition-colors",
        isAm
          ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
          : "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
        active &&
          (isAm
            ? "bg-sky-500 text-white border-sky-500 shadow-sm"
            : "bg-indigo-500 text-white border-indigo-500 shadow-sm"),
        className,
      )}
    >
      {half.toUpperCase()}
    </span>
  );
}

export function startOfMonth(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function endOfMonth(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function buildDays(anchor: Date, mode: ViewMode, includeWeekend = false): Date[] {
  if (mode === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  if (mode === "month") {
    const start = startOfMonth(anchor);
    const end = endOfMonth(anchor);
    const out: Date[] = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const dow = d.getDay();
      if (!includeWeekend && (dow === 0 || dow === 6)) continue;
      out.push(new Date(d));
    }
    return out;
  }
  const ws = startOfWeek(anchor);
  const len = includeWeekend ? 7 : 5;
  return Array.from({ length: len }, (_, i) => addDays(ws, i));
}

export function shiftAnchor(anchor: Date, mode: ViewMode, dir: 1 | -1): Date {
  if (mode === "day") return addDays(anchor, dir);
  if (mode === "week") return addDays(anchor, dir * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}

export function ViewModeToggle({
  mode, onChange,
}: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="inline-flex rounded-md border">
      {(["day", "week", "month"] as ViewMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={cn(
            "px-3 py-1 text-xs font-medium capitalize first:rounded-l-md last:rounded-r-md",
            mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export function PeriodNav({
  anchor, mode, onChange,
}: { anchor: Date; mode: ViewMode; onChange: (d: Date) => void }) {
  const label = (() => {
    if (mode === "day") return anchor.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (mode === "month") return anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const ws = startOfWeek(anchor);
    return `Week of ${fmt(ws)}`;
  })();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => onChange(shiftAnchor(anchor, mode, -1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1 min-w-[140px] rounded-md border px-3 py-1 text-xs font-medium tabular-nums text-center sm:flex-none sm:min-w-[180px]">
        {label}
      </div>
      <Button variant="outline" size="sm" onClick={() => onChange(shiftAnchor(anchor, mode, 1))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onChange(new Date())}>
        Today
      </Button>
    </div>
  );
}

export function WeekPicker({
  weekStart, onChange, days,
}: {
  weekStart: Date; onChange: (d: Date) => void; days?: 5 | 7;
}) {
  void days;
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => onChange(addDays(weekStart, -7))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Input
        type="date" value={iso(weekStart)}
        onChange={(e) => {
          const d = parseDateLocal(e.target.value);
          if (d) onChange(startOfWeek(d));
        }}
        className="h-8 w-40"
      />
      <Button variant="outline" size="sm" onClick={() => onChange(addDays(weekStart, 7))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onChange(startOfWeek(new Date()))}>
        This week
      </Button>
    </div>
  );
}

/* --------------------- Global read-only grid --------------------- */

export function GlobalWeekGrid({ weekStart, days: daysProp }: { weekStart: Date; days?: Date[] }) {
  const days = useMemo(
    () => daysProp ?? Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)),
    [weekStart, daysProp],
  );
  const startIso = iso(days[0]);
  const endIso = iso(days[days.length - 1]);

  const { data: theatres } = useQuery({
    queryKey: ["theatres-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres").select("id,name,kind,sort_order")
        .eq("active", true).order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: sessions } = useQuery({
    queryKey: ["theatre-sessions", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,theatre_id,session,session_date,surgical_consultant,specialty_id,is_non_sag")
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return data;
    },
  });

  const { data: assignments } = useQuery({
    queryKey: ["assignments", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,theatre_session_id,role_on_list")
        .eq("duty_type", "theatre")
        .in("session", ["am", "pm"])
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; staff_id: string; session: SessionHalf; session_date: string;
        theatre_session_id: string | null; role_on_list: string;
      }>;
    },
  });

  const { data: nhhOncall } = useQuery({
    queryKey: ["nhh-oncall", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date")
        .eq("duty_type", "nhh_oncall")
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; staff_id: string; session: string; session_date: string;
      }>;
    },
  });

  const { data: spaAdmin } = useQuery({
    queryKey: ["spa-admin", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,duty_type")
        .in("duty_type", ["spa", "admin"])
        .in("session", ["am", "pm"])
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; staff_id: string; session: SessionHalf; session_date: string;
        duty_type: "spa" | "admin";
      }>;
    },
  });

  const listActive = useServerFn(listActiveStaffSafe);
  const { data: staff } = useQuery({
    queryKey: ["staff-active-with-grade-safe"],
    queryFn: () => listActive(),
  });

  const { data: specs } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties").select("id,name");
      if (error) throw error;
      return data;
    },
  });

  const staffById = (id: string | null) => staff?.find((s) => s.id === id);
  const staffName = (id: string | null) => staffById(id)?.full_name ?? "—";
  const specName = (id: string | null) => (id ? specs?.find((s) => s.id === id)?.name : undefined);
  const cellSession = (theatreId: string, date: string, s: SessionHalf) =>
    sessions?.find((x) => x.theatre_id === theatreId && x.session_date === date && x.session === s);
  const gradeRank = (g: string | null | undefined) =>
    g === "consultant" ? 0 : g === "sas" ? 1 : g === "trainee" ? 2 : 3;
  const cellAssigns = (sessionId?: string) => {
    const list = sessionId ? assignments?.filter((a) => a.theatre_session_id === sessionId) ?? [] : [];
    return [...list].sort(
      (a, b) => gradeRank(staffById(a.staff_id)?.grade) - gradeRank(staffById(b.staff_id)?.grade),
    );
  };

  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>
              <th className="border-b border-r p-2 text-left font-medium w-28">Theatre</th>
              {days.map((d) => (
                <th key={iso(d)} colSpan={2} className="border-b border-r p-2 text-center font-medium">
                  {fmt(d)}
                </th>
              ))}
            </tr>
            <tr className="text-muted-foreground">
              <th className="border-b border-r p-1"></th>
              {days.flatMap((d) => [
                <th key={iso(d) + "am"} className="border-b p-1 font-normal">
                  <SessionChip half="am" />
                </th>,
                <th key={iso(d) + "pm"} className="border-b border-r p-1 font-normal">
                  <SessionChip half="pm" />
                </th>,
              ])}
            </tr>

          </thead>
          <tbody>
            {theatres?.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="border-r p-2 font-medium whitespace-nowrap">
                  {t.name}
                  <div className="text-[10px] text-muted-foreground">
                    {t.kind === "main"
                      ? "Main"
                      : t.kind === "day_surgery"
                      ? "Day surgery"
                      : "Private (NHH)"}
                  </div>
                </td>
                {days.flatMap((d) =>
                  (["am", "pm"] as SessionHalf[]).map((s) => {
                    const ts = cellSession(t.id, iso(d), s);
                    const assigns = cellAssigns(ts?.id);
                    const isPm = s === "pm";
                    const spec = specName(ts?.specialty_id ?? null);
                    return (
                      <td
                        key={t.id + iso(d) + s}
                        className={cn(
                          "min-w-[110px] border-b p-1.5 align-top",
                          isPm ? "border-r" : "border-r border-r-border/30",
                        )}
                      >
                        {ts ? (
                          <div className="space-y-1">
                            {ts.is_non_sag && (
                              <Badge
                                variant="outline"
                                className="text-[9px] border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                title="NHH list covered as part of NHS job plan (non-SAG)"
                              >
                                Non-SAG
                              </Badge>
                            )}
                            {spec && <div className="font-bold truncate text-green-600 dark:text-green-400">{spec}</div>}
                            {ts.surgical_consultant && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {ts.surgical_consultant}
                              </div>
                            )}
                            {(() => {
                              const hasConsultant = assigns.some(
                                (x) => staffById(x.staff_id)?.grade === "consultant",
                              );
                              return assigns.map((a) => {
                                const sp = staffById(a.staff_id);
                                const isConsultant = sp?.grade === "consultant";
                                const isTrainee = sp?.grade === "trainee";
                                const isSoloTrainee = isTrainee && a.role_on_list === "solo" && !hasConsultant;
                                // Hide the "solo" badge for consultants and for
                                // trainees who are working alongside a consultant.
                                const showRoleBadge = !(
                                  a.role_on_list === "solo" && (isConsultant || !isSoloTrainee)
                                );
                                return (
                                  <Link
                                    key={a.id}
                                    to="/calendar/staff/$staffId"
                                    params={{ staffId: a.staff_id }}
                                    className={cn(
                                      "block truncate text-[10px] hover:underline",
                                      isConsultant && "font-bold",
                                      isTrainee && "text-blue-600 dark:text-blue-400",
                                    )}
                                  >
                                    {showRoleBadge && (
                                      <Badge
                                        variant={a.role_on_list === "supervising" ? "default" : "outline"}
                                        className={cn(
                                          "mr-1 px-1 py-0 text-[9px]",
                                          a.role_on_list === "solo" && "bg-yellow-400 text-black border-yellow-500 hover:bg-yellow-400",
                                        )}
                                      >
                                        {a.role_on_list}
                                      </Badge>
                                    )}
                                    {staffName(a.staff_id)}
                                    {isTrainee ? ` (${sp?.training_level || "Level unknown"})` : ""}
                                  </Link>
                                );
                              });
                            })()}

                          </div>
                        ) : (
                          <div className="text-muted-foreground/40 text-[10px]">—</div>
                        )}
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
            {/* SPA and Admin sessions — non-clinical, broken down per AM/PM. */}
            {([
              { key: "spa", label: "SPA", sub: "Supporting prof. activities", tint: "bg-emerald-500/5" },
              { key: "admin", label: "Admin", sub: "Administrative time", tint: "bg-sky-500/5" },
            ] as const).map((row) => (
              <tr key={row.key} className={cn("align-top", row.tint)}>
                <td className="border-r border-t p-2 font-medium whitespace-nowrap">
                  {row.label}
                  <div className="text-[10px] text-muted-foreground">{row.sub}</div>
                </td>
                {days.flatMap((d) =>
                  (["am", "pm"] as SessionHalf[]).map((s) => {
                    const dayIso = iso(d);
                    const cell = (spaAdmin ?? [])
                      .filter((a) => a.duty_type === row.key && a.session_date === dayIso && a.session === s);
                    const sorted = [...cell].sort(
                      (a, b) => gradeRank(staffById(a.staff_id)?.grade) - gradeRank(staffById(b.staff_id)?.grade),
                    );
                    const isPm = s === "pm";
                    return (
                      <td
                        key={row.key + dayIso + s}
                        className={cn(
                          "min-w-[110px] border-b border-t p-1.5 align-top",
                          isPm ? "border-r" : "border-r border-r-border/30",
                        )}
                      >
                        {sorted.length > 0 ? (
                          <div className="space-y-1">
                            {sorted.map((a) => {
                              const sp = staffById(a.staff_id);
                              const isConsultant = sp?.grade === "consultant";
                              const isTrainee = sp?.grade === "trainee";
                              return (
                                <Link
                                  key={a.id}
                                  to="/calendar/staff/$staffId"
                                  params={{ staffId: a.staff_id }}
                                  className={cn(
                                    "block truncate text-[10px] hover:underline",
                                    isConsultant && "font-bold",
                                    isTrainee && "text-blue-600 dark:text-blue-400",
                                  )}
                                >
                                  {staffName(a.staff_id)}
                                  {isTrainee ? ` (${sp?.training_level || "Level unknown"})` : ""}
                                </Link>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-muted-foreground/40 text-[10px]">—</div>
                        )}
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
            {/* NHH 1st On-call — out-of-hours cover for New Hall Hospital.
                Spans the whole day so we render one cell per date (colSpan=2). */}
            <tr className="align-top bg-purple-500/5">
              <td className="border-r border-t p-2 font-medium whitespace-nowrap">
                NHH 1st On-call
                <div className="text-[10px] text-muted-foreground">Out of hours</div>
              </td>
              {days.map((d) => {
                const dayIso = iso(d);
                const dayAssigns = (nhhOncall ?? []).filter(
                  (a) => a.session_date === dayIso,
                );
                // De-dupe by staff (a consultant may appear under eve+night).
                const uniqueStaff = Array.from(
                  new Set(dayAssigns.map((a) => a.staff_id)),
                );
                return (
                  <td
                    key={"nhh-" + dayIso}
                    colSpan={2}
                    className="min-w-[110px] border-b border-t border-r p-1.5 align-top"
                  >
                    {uniqueStaff.length > 0 ? (
                      <div className="space-y-1">
                        <Badge
                          variant="outline"
                          className="px-1 py-0 text-[9px] border-purple-500 text-purple-700 dark:text-purple-300"
                        >
                          OOH
                        </Badge>
                        {uniqueStaff.map((sid) => (
                          <Link
                            key={sid}
                            to="/calendar/staff/$staffId"
                            params={{ staffId: sid }}
                            className="block truncate text-[10px] font-bold hover:underline"
                          >
                            {staffName(sid)}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <div className="text-muted-foreground/40 text-[10px]">—</div>
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/* --------------------- Per-staff week view --------------------- */

export function StaffWeekView({ staffId }: { staffId: string }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const toggleDay = (dayIso: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayIso)) next.delete(dayIso);
      else next.add(dayIso);
      return next;
    });
  };
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const startIso = iso(days[0]);
  const endIso = iso(days[days.length - 1]);

  const lookupStaff = useServerFn(listStaffByIdsSafe);
  const { data: profile } = useQuery({
    queryKey: ["profile-safe", staffId],
    queryFn: async () => {
      const rows = await lookupStaff({ data: { ids: [staffId] } });
      return rows[0] ?? null;
    },
  });

  const { data: assigns } = useQuery({
    queryKey: ["staff-assigns", staffId, startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,session,session_date,theatre_session_id,role_on_list,supervisor_id")
        .eq("staff_id", staffId)
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return data;
    },
  });

  const sessionIds = (assigns ?? []).map((a) => a.theatre_session_id).filter(Boolean) as string[];
  const { data: ts } = useQuery({
    queryKey: ["staff-theatre-sessions", sessionIds],
    enabled: sessionIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,theatre_id,specialty_id,surgical_consultant,is_non_sag")
        .in("id", sessionIds);
      if (error) throw error;
      return data;
    },
  });

  const { data: theatres } = useQuery({
    queryKey: ["theatres-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres").select("id,name").order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: specs } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase.from("specialties").select("id,name");
      if (error) throw error;
      return data;
    },
  });

  const { data: leave } = useQuery({
    queryKey: ["staff-leave", staffId, startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leave_requests")
        .select("id,type,status,start_date,end_date,half_day_start,half_day_end")
        .eq("staff_id", staffId)
        .lte("start_date", endIso).gte("end_date", startIso);
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2
            className={cn(
              "text-xl font-semibold",
              profile?.grade === "consultant" && "font-bold",
            )}
          >
            {profile?.full_name ?? "Staff member"}
            {profile?.grade === "trainee"
              ? ` (${profile?.training_level || "Level unknown"})`
              : ""}
          </h2>
          <p className="text-sm text-muted-foreground">
            {profile?.grade ?? "—"}
            {profile?.grade === "trainee" ? ` · ${profile?.training_level || "Level unknown"}` : ""}
          </p>
        </div>
        <WeekPicker weekStart={weekStart} onChange={setWeekStart} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {days.map((d) => {
          const dayIso = iso(d);
          const dayAssigns = assigns?.filter((a) => a.session_date === dayIso) ?? [];
          const dayLeave = leave?.filter(
            (l) => l.start_date <= dayIso && l.end_date >= dayIso,
          ) ?? [];
          const isToday = dayIso === iso(new Date());
          return (
            <Card key={dayIso} className={cn(isToday && "ring-2 ring-primary")}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-sm font-medium">{fmt(d)}</div>
                  {isToday && <Badge variant="default" className="shrink-0 text-[9px]">Today</Badge>}
                </div>
                {dayLeave.map((l) => (
                  <div key={l.id} className="rounded bg-amber-500/10 p-2 text-xs">
                    <Badge variant="outline" className="mr-1">{l.type}</Badge>
                    <span className="text-muted-foreground">{l.status}</span>
                  </div>
                ))}
                <div className="grid grid-cols-1 gap-2">
                  {(["am", "pm"] as SessionHalf[]).map((sh) => {
                    const a = dayAssigns.find((x) => x.session === sh);
                    const session = a && ts?.find((s) => s.id === a.theatre_session_id);
                    const theatre = session && theatres?.find((t) => t.id === session.theatre_id);
                    const spec = session && specs?.find((s) => s.id === session.specialty_id);
                    return (
                      <div key={sh} className="rounded border p-3 text-xs">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{sh}</div>
                        {a ? (
                          <div className="space-y-1">
                            <div className="min-w-0 truncate font-medium">{theatre?.name ?? "—"}</div>
                            {session?.is_non_sag && (
                              <Badge
                                variant="outline"
                                className="text-[9px] border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                title="NHH list covered as part of NHS job plan (non-SAG)"
                              >
                                Non-SAG
                              </Badge>
                            )}
                            {spec && <div className="min-w-0 truncate text-muted-foreground">{spec.name}</div>}
                            {session?.surgical_consultant && (
                              <div className="min-w-0 truncate text-muted-foreground">{session.surgical_consultant}</div>
                            )}
                            <Badge variant="outline" className="text-[9px]">
                              {a.role_on_list}
                            </Badge>
                          </div>
                        ) : (
                          <div className="text-muted-foreground/60">—</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------- Staff picker --------------------- */

export function StaffPicker({
  value, onChange,
}: { value?: string; onChange: (id: string) => void }) {
  const listActive = useServerFn(listActiveStaffSafe);
  const { data } = useQuery({
    queryKey: ["staff-active-safe"],
    queryFn: () => listActive(),
  });
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-64">
        <User className="mr-2 h-4 w-4" />
        <SelectValue placeholder="Jump to staff…" />
      </SelectTrigger>
      <SelectContent>
        {data
          ?.sort((a, b) => compareBySurname(a.full_name, b.full_name))
          .map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.full_name} {s.grade ? `(${s.grade})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
