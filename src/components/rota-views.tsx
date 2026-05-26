import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, User } from "lucide-react";
import { cn, parseDateLocal } from "@/lib/utils";

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
export function iso(d: Date) { return d.toISOString().slice(0, 10); }
export function fmt(d: Date) {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export type ViewMode = "day" | "week" | "month";

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
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => onChange(shiftAnchor(anchor, mode, -1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div className="rounded-md border px-3 py-1 text-xs font-medium tabular-nums min-w-[180px] text-center">
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
        .select("id,theatre_id,session,session_date,surgical_consultant,specialty_id")
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

  const { data: staff } = useQuery({
    queryKey: ["staff-active-with-grade"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("id,full_name,grade,training_level").eq("active", true);
      if (error) throw error;
      return data;
    },
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
                <th key={iso(d) + "am"} className="border-b p-1 font-normal">AM</th>,
                <th key={iso(d) + "pm"} className="border-b border-r p-1 font-normal">PM</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {theatres?.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="border-r p-2 font-medium whitespace-nowrap">
                  {t.name}
                  <div className="text-[10px] text-muted-foreground">
                    {t.kind === "main" ? "Main" : "Day surgery"}
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
                            {spec && <div className="font-medium truncate">{spec}</div>}
                            {ts.surgical_consultant && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {ts.surgical_consultant}
                              </div>
                            )}
                            {assigns.map((a) => {
                              const sp = staffById(a.staff_id);
                              const isConsultant = sp?.grade === "consultant";
                              const isTrainee = sp?.grade === "trainee";
                              const highlightTrainee = isTrainee && a.role_on_list === "solo";
                              return (
                                <Link
                                  key={a.id}
                                  to="/calendar/staff/$staffId"
                                  params={{ staffId: a.staff_id }}
                                  className={cn(
                                    "block truncate text-[10px] hover:underline",
                                    isConsultant && "font-bold",
                                    highlightTrainee && "text-blue-600 dark:text-blue-400",
                                  )}
                                >
                                  <Badge
                                    variant={a.role_on_list === "supervising" ? "default" : "outline"}
                                    className="mr-1 px-1 py-0 text-[9px]"
                                  >
                                    {a.role_on_list}
                                  </Badge>
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
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/* --------------------- Per-staff week view --------------------- */

export function StaffWeekView({ staffId }: { staffId: string }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const startIso = iso(days[0]);
  const endIso = iso(days[days.length - 1]);

  const { data: profile } = useQuery({
    queryKey: ["profile", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("id,full_name,grade,training_level")
        .eq("id", staffId).maybeSingle();
      if (error) throw error;
      return data;
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
        .select("id,theatre_id,specialty_id,surgical_consultant")
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
        <div>
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
            {profile?.email ? ` · ${profile.email}` : ""}
          </p>
        </div>
        <WeekPicker weekStart={weekStart} onChange={setWeekStart} />
      </div>

      <div className="grid gap-3 md:grid-cols-7">
        {days.map((d) => {
          const dayIso = iso(d);
          const dayAssigns = assigns?.filter((a) => a.session_date === dayIso) ?? [];
          const dayLeave = leave?.filter(
            (l) => l.start_date <= dayIso && l.end_date >= dayIso,
          ) ?? [];
          const isToday = dayIso === iso(new Date());
          return (
            <Card key={dayIso} className={cn(isToday && "ring-2 ring-primary")}>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">{fmt(d)}</div>
                  {isToday && <Badge variant="default" className="text-[9px]">Today</Badge>}
                </div>
                {dayLeave.map((l) => (
                  <div key={l.id} className="rounded bg-amber-500/10 p-2 text-xs">
                    <Badge variant="outline" className="mr-1">{l.type}</Badge>
                    <span className="text-muted-foreground">{l.status}</span>
                  </div>
                ))}
                {(["am", "pm"] as SessionHalf[]).map((sh) => {
                  const a = dayAssigns.find((x) => x.session === sh);
                  const session = a && ts?.find((s) => s.id === a.theatre_session_id);
                  const theatre = session && theatres?.find((t) => t.id === session.theatre_id);
                  const spec = session && specs?.find((s) => s.id === session.specialty_id);
                  return (
                    <div key={sh} className="rounded border p-2 text-xs">
                      <div className="text-[10px] uppercase text-muted-foreground">{sh}</div>
                      {a ? (
                        <div className="space-y-0.5">
                          <div className="font-medium">{theatre?.name ?? "—"}</div>
                          {spec && <div className="text-muted-foreground">{spec.name}</div>}
                          {session?.surgical_consultant && (
                            <div className="text-muted-foreground">{session.surgical_consultant}</div>
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
  const { data } = useQuery({
    queryKey: ["staff-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("id,full_name,grade")
        .eq("active", true).order("full_name");
      if (error) throw error;
      return data;
    },
  });
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-64">
        <User className="mr-2 h-4 w-4" />
        <SelectValue placeholder="Jump to staff…" />
      </SelectTrigger>
      <SelectContent>
        {data?.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.full_name} {s.grade ? `(${s.grade})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
