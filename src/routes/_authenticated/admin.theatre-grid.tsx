import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/theatre-grid")({
  component: TheatreGridPage,
});

type Sess = "am" | "pm";
const SESSIONS: Sess[] = ["am", "pm"];
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function mondayOf(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // 0 = Mon
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

type SessionRow = {
  id: string;
  theatre_id: string;
  session_date: string;
  session: Sess;
  specialty_id: string | null;
  surgical_consultant: string | null;
};

function TheatreGridPage() {
  const [weekStart, setWeekStart] = useState<Date>(mondayOf(new Date()));
  const [includeWeekend, setIncludeWeekend] = useState(false);

  const dayCount = includeWeekend ? 7 : 5;
  const days = Array.from({ length: dayCount }, (_, i) => addDays(weekStart, i));
  const startISO = isoDate(weekStart);
  const endISO = isoDate(addDays(weekStart, dayCount - 1));

  const qc = useQueryClient();

  const { data: theatres } = useQuery({
    queryKey: ["theatres"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres")
        .select("id,name,kind,active,sort_order")
        .eq("active", true)
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: specialties } = useQuery({
    queryKey: ["specialties"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties")
        .select("id,name")
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["theatre-sessions-grid", startISO, endISO],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,theatre_id,session_date,session,specialty_id,surgical_consultant")
        .gte("session_date", startISO)
        .lte("session_date", endISO);
      if (error) throw error;
      return data as SessionRow[];
    },
  });

  const cellIndex = useMemo(() => {
    const m = new Map<string, SessionRow>();
    for (const s of sessions ?? []) {
      m.set(`${s.theatre_id}|${s.session_date}|${s.session}`, s);
    }
    return m;
  }, [sessions]);

  const upsert = useMutation({
    mutationFn: async (args: {
      cell: SessionRow | undefined;
      theatre_id: string;
      session_date: string;
      session: Sess;
      patch: Partial<Pick<SessionRow, "specialty_id" | "surgical_consultant">>;
    }) => {
      if (args.cell) {
        const { error } = await supabase
          .from("theatre_sessions")
          .update(args.patch)
          .eq("id", args.cell.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("theatre_sessions").insert({
          theatre_id: args.theatre_id,
          session_date: args.session_date,
          session: args.session,
          specialty_id: args.patch.specialty_id ?? null,
          surgical_consultant: args.patch.surgical_consultant ?? null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["theatre-sessions-grid", startISO, endISO] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("theatre_sessions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["theatre-sessions-grid", startISO, endISO] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Theatre session grid</h1>
          <p className="text-sm text-muted-foreground">
            Configure AM/PM sessions for every theatre. Pick a specialty and operating consultant per slot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="rounded-md border px-3 py-1.5 text-sm font-medium tabular-nums">
            {startISO} – {endISO}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWeekStart(mondayOf(new Date()))}
          >
            This week
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIncludeWeekend((v) => !v)}
          >
            {includeWeekend ? "Mon–Fri" : "Include weekend"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Week of {startISO}</CardTitle>
          <CardDescription>
            Empty cells become new sessions when you choose a specialty or type a consultant.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !theatres?.length ? (
            <p className="text-sm text-muted-foreground">
              No active theatres. Add some in Theatres first.
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-card p-2 text-left font-medium">Theatre</th>
                  {days.map((d, i) => (
                    <th key={i} colSpan={2} className="border-l p-2 text-center font-medium">
                      {DAY_LABELS[i]} <span className="text-muted-foreground">{isoDate(d).slice(5)}</span>
                    </th>
                  ))}
                </tr>
                <tr className="text-[10px] uppercase text-muted-foreground">
                  <th className="sticky left-0 z-10 bg-card"></th>
                  {days.flatMap((d, i) =>
                    SESSIONS.map((s) => (
                      <th key={`${i}-${s}`} className="border-l p-1 text-center font-medium">
                        {s}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {theatres.map((t) => (
                  <tr key={t.id} className="border-t align-top">
                    <td className="sticky left-0 z-10 bg-card p-2 align-top font-medium">
                      {t.name}
                      <div className="text-[10px] uppercase text-muted-foreground">{t.kind}</div>
                    </td>
                    {days.flatMap((d) => {
                      const date = isoDate(d);
                      return SESSIONS.map((s) => {
                        const cell = cellIndex.get(`${t.id}|${date}|${s}`);
                        return (
                          <td key={`${t.id}-${date}-${s}`} className="border-l p-1 align-top">
                            <Cell
                              cell={cell}
                              theatreId={t.id}
                              date={date}
                              session={s}
                              specialties={specialties ?? []}
                              onChange={(patch) =>
                                upsert.mutate({
                                  cell,
                                  theatre_id: t.id,
                                  session_date: date,
                                  session: s,
                                  patch,
                                })
                              }
                              onClear={() => cell && remove.mutate(cell.id)}
                            />
                          </td>
                        );
                      });
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Cell({
  cell, theatreId, date, session, specialties, onChange, onClear,
}: {
  cell: SessionRow | undefined;
  theatreId: string;
  date: string;
  session: Sess;
  specialties: { id: string; name: string }[];
  onChange: (patch: Partial<Pick<SessionRow, "specialty_id" | "surgical_consultant">>) => void;
  onClear: () => void;
}) {
  const [consultant, setConsultant] = useState(cell?.surgical_consultant ?? "");
  // Reset local value if cell identity changes
  const cellKey = `${theatreId}|${date}|${session}|${cell?.id ?? ""}`;
  const [lastKey, setLastKey] = useState(cellKey);
  if (lastKey !== cellKey) {
    setLastKey(cellKey);
    setConsultant(cell?.surgical_consultant ?? "");
  }

  return (
    <div className="space-y-1">
      <Select
        value={cell?.specialty_id ?? "__none"}
        onValueChange={(v) => onChange({ specialty_id: v === "__none" ? null : v })}
      >
        <SelectTrigger className="h-7 text-xs">
          <SelectValue placeholder="Specialty" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">— none —</SelectItem>
          {specialties.map((sp) => (
            <SelectItem key={sp.id} value={sp.id}>{sp.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1">
        <Input
          value={consultant}
          placeholder="Consultant"
          onChange={(e) => setConsultant(e.target.value)}
          onBlur={() => {
            if ((cell?.surgical_consultant ?? "") !== consultant) {
              onChange({ surgical_consultant: consultant.trim() || null });
            }
          }}
          className="h-7 text-xs"
        />
        {cell && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={onClear}
            title="Clear session"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
