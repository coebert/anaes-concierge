import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { cn, toISODateLocal } from "@/lib/utils";
import { loadCalendarLeave, type CalendarLeaveEntry } from "@/lib/audit/leave-pressure";

/**
 * Map a (type, status) pair to a chip style.
 *
 * Categories explicitly requested:
 *  - approved annual → green
 *  - pending annual → yellow
 *  - professional (any status) → blue
 *  - sick (any status) → red
 * Other leave types use neutral styling so the requested categories stay
 * visually distinct.
 */
function chipClass(type: string, status: string): string {
  const t = (type ?? "").toLowerCase();
  if (t === "annual") {
    return status === "approved"
      ? "bg-emerald-500/85 text-white border-emerald-600"
      : "bg-yellow-300 text-yellow-950 border-yellow-500";
  }
  if (t === "professional") return "bg-blue-500/85 text-white border-blue-600";
  if (t === "sick") return "bg-red-500/85 text-white border-red-600";
  if (t === "study") return "bg-violet-400/80 text-white border-violet-500";
  if (t === "parental") return "bg-pink-400/80 text-white border-pink-500";
  if (t === "compassionate") return "bg-slate-500/80 text-white border-slate-600";
  return "bg-muted text-foreground border-border";
}

function monthStart(year: number, monthIdx: number): Date {
  return new Date(year, monthIdx, 1);
}

function gridStart(d: Date): Date {
  // Monday-first week: shift back to nearest Monday on/before d.
  const out = new Date(d);
  const dow = out.getDay(); // 0 Sun..6 Sat
  const back = dow === 0 ? 6 : dow - 1;
  out.setDate(out.getDate() - back);
  return out;
}

function gridEnd(d: Date): Date {
  const out = new Date(d);
  const dow = out.getDay();
  const fwd = dow === 0 ? 0 : 7 - dow;
  out.setDate(out.getDate() + fwd);
  return out;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function LeaveMonthlyCalendar() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(today.getMonth());

  const { rangeStart, rangeEnd, gridDays, firstOfMonth } = useMemo(() => {
    const first = monthStart(year, monthIdx);
    const lastOfMonth = new Date(year, monthIdx + 1, 0);
    const gs = gridStart(first);
    const ge = gridEnd(lastOfMonth);
    const days: Date[] = [];
    for (let d = new Date(gs); d <= ge; d.setDate(d.getDate() + 1)) {
      days.push(new Date(d));
    }
    return {
      rangeStart: toISODateLocal(gs),
      rangeEnd: toISODateLocal(ge),
      gridDays: days,
      firstOfMonth: first,
    };
  }, [year, monthIdx]);

  const { data, isLoading } = useQuery({
    queryKey: ["leave-calendar", rangeStart, rangeEnd],
    queryFn: () => loadCalendarLeave(rangeStart, rangeEnd),
  });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarLeaveEntry[]>();
    for (const e of data ?? []) {
      const arr = map.get(e.date) ?? [];
      arr.push(e);
      map.set(e.date, arr);
    }
    // Sort within day: requested categories first, then by name.
    const rank = (e: CalendarLeaveEntry) => {
      const t = e.type.toLowerCase();
      if (t === "annual" && e.status === "approved") return 0;
      if (t === "annual") return 1;
      if (t === "professional") return 2;
      if (t === "sick") return 3;
      return 4;
    };
    for (const arr of map.values()) {
      arr.sort((a, b) => rank(a) - rank(b) || a.staffName.localeCompare(b.staffName));
    }
    return map;
  }, [data]);

  const goto = (delta: number) => {
    const d = new Date(year, monthIdx + delta, 1);
    setYear(d.getFullYear());
    setMonthIdx(d.getMonth());
  };

  const todayISO = toISODateLocal(today);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            Monthly leave calendar
          </CardTitle>
          <CardDescription>
            All approved &amp; pending leave across every staff group for the selected month.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="outline" size="sm" onClick={() => goto(-1)} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-[140px] text-center text-sm font-medium tabular-nums">
            {MONTHS[monthIdx]} {year}
          </div>
          <Button variant="outline" size="sm" onClick={() => goto(1)} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setYear(today.getFullYear());
              setMonthIdx(today.getMonth());
            }}
          >
            Today
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Legend />
        <div className="mt-3 grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {WEEKDAYS.map((w) => (
            <div key={w} className="text-center">{w}</div>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {gridDays.map((d) => {
            const iso = toISODateLocal(d);
            const inMonth = d.getMonth() === firstOfMonth.getMonth();
            const entries = byDay.get(iso) ?? [];
            const isToday = iso === todayISO;
            const visible = entries.slice(0, 4);
            const extra = entries.length - visible.length;
            return (
              <div
                key={iso}
                className={cn(
                  "min-h-[88px] rounded-md border p-1 text-xs",
                  inMonth ? "bg-card" : "bg-muted/30 text-muted-foreground",
                  isToday && "ring-2 ring-primary",
                )}
                title={
                  entries.length
                    ? entries
                        .map((e) => `${e.staffName} — ${e.type} (${e.status})`)
                        .join("\n")
                    : undefined
                }
              >
                <div className="flex items-center justify-between">
                  <span className={cn("font-medium tabular-nums", isToday && "text-primary")}>
                    {d.getDate()}
                  </span>
                  {entries.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">{entries.length}</span>
                  )}
                </div>
                <div className="mt-1 space-y-0.5">
                  {visible.map((e, i) => (
                    <div
                      key={`${e.staffId}-${e.startDate}-${i}`}
                      className={cn(
                        "truncate rounded border px-1 py-px text-[10px] leading-tight",
                        chipClass(e.type, e.status),
                      )}
                    >
                      {e.staffName}
                      {e.status === "pending" ? " ·" : ""}
                    </div>
                  ))}
                  {extra > 0 && (
                    <div className="text-[10px] text-muted-foreground">+{extra} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {isLoading && (
          <div className="mt-3 text-xs text-muted-foreground">Loading leave…</div>
        )}
      </CardContent>
    </Card>
  );
}

function Legend() {
  const items: Array<{ label: string; className: string }> = [
    { label: "Annual (approved)", className: "bg-emerald-500/85 text-white border-emerald-600" },
    { label: "Annual (pending)", className: "bg-yellow-300 text-yellow-950 border-yellow-500" },
    { label: "Professional", className: "bg-blue-500/85 text-white border-blue-600" },
    { label: "Sick", className: "bg-red-500/85 text-white border-red-600" },
    { label: "Study", className: "bg-violet-400/80 text-white border-violet-500" },
    { label: "Parental", className: "bg-pink-400/80 text-white border-pink-500" },
    { label: "Compassionate / other", className: "bg-slate-500/80 text-white border-slate-600" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
      {items.map((i) => (
        <span key={i.label} className={cn("rounded border px-1.5 py-0.5", i.className)}>
          {i.label}
        </span>
      ))}
    </div>
  );
}
