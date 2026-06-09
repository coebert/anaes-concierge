import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { formatDateGB } from "@/lib/utils";
import { isoDate, weekdayShort } from "@/lib/theatre-grid-dates";
import {
  ViewModeToggle, PeriodNav, buildDays, type ViewMode,
} from "@/components/rota-views";

export const Route = createFileRoute("/_authenticated/admin/theatre-grid")({
  component: TheatreGridPage,
});

type Sess = "am" | "pm";
const SESSIONS: Sess[] = ["am", "pm"];

type SessionRow = {
  id: string;
  theatre_id: string;
  session_date: string;
  session: Sess;
  specialty_id: string | null;
  surgical_consultant: string | null;
  is_non_sag: boolean;
  non_sag_override: boolean;
};

type SessionPatch = Partial<
  Pick<SessionRow, "specialty_id" | "surgical_consultant" | "is_non_sag" | "non_sag_override">
>;

function TheatreGridPage() {
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [mode, setMode] = useState<ViewMode>("week");
  // Default to including weekends — some theatre lists (incl. private hospital) run on Sat/Sun.
  const [includeWeekend, setIncludeWeekend] = useState(true);

  const days = useMemo(() => buildDays(anchor, mode, includeWeekend), [anchor, mode, includeWeekend]);
  const startISO = isoDate(days[0]);
  const endISO = isoDate(days[days.length - 1]);


  const qc = useQueryClient();

  const { data: theatres } = useQuery({
    queryKey: ["theatres"],
    staleTime: 5 * 60_000,
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
    staleTime: 5 * 60_000,
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
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,theatre_id,session_date,session,specialty_id,surgical_consultant,is_non_sag,non_sag_override")
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
      patch: SessionPatch;
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
          is_non_sag: args.patch.is_non_sag ?? false,
          non_sag_override: args.patch.non_sag_override ?? false,
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
        <div className="flex flex-wrap items-center gap-2">
          <ViewModeToggle mode={mode} onChange={setMode} />
          <PeriodNav anchor={anchor} mode={mode} onChange={setAnchor} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIncludeWeekend((v) => !v)}
          >
            {includeWeekend ? "Hide weekend" : "Include weekend"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{startISO} – {endISO}</CardTitle>
          <CardDescription>
            Empty cells become new sessions when you choose a specialty or type a consultant.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !theatres?.length ? (
            <p className="text-sm text-muted-foreground">
              No active theatres. Add some in Theatres first.
            </p>
          ) : (
            <VirtualGrid
              theatres={theatres}
              days={days}
              cellIndex={cellIndex}
              specialties={specialties ?? []}
              onUpsert={(theatre_id, session_date, session, cell, patch) =>
                upsert.mutate({ cell, theatre_id, session_date, session, patch })
              }
              onRemove={(id) => remove.mutate(id)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type Theatre = { id: string; name: string; kind: "main" | "day_surgery" | "private" };

const DAY_COL_PX = 280; // ~140px per am/pm session cell

function VirtualGrid({
  theatres, days, cellIndex, specialties, onUpsert, onRemove,
}: {
  theatres: Theatre[];
  days: Date[];
  cellIndex: Map<string, SessionRow>;
  specialties: { id: string; name: string }[];
  onUpsert: (theatreId: string, date: string, session: Sess, cell: SessionRow | undefined, patch: SessionPatch) => void;
  onRemove: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rangeKey = `${isoDate(days[0])}|${isoDate(days[days.length - 1])}`;

  // Snap scroll back to the top-left when the date range changes so the
  // virtualizer doesn't have to re-measure inherited mid-page offsets — that
  // re-measure is the source of the visible jump when jumping weeks.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: 0, left: 0 });
  }, [rangeKey]);

  const rowVirt = useVirtualizer({
    count: theatres.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 8,
    getItemKey: (i) => theatres[i].id,
  });

  const colVirt = useVirtualizer({
    count: days.length,
    getScrollElement: () => scrollRef.current,
    horizontal: true,
    estimateSize: () => DAY_COL_PX,
    overscan: 3,
    getItemKey: (i) => isoDate(days[i]),
  });

  const rowItems = rowVirt.getVirtualItems();
  const rowTotal = rowVirt.getTotalSize();
  const paddingTop = rowItems.length ? rowItems[0].start : 0;
  const paddingBottom = rowItems.length ? rowTotal - rowItems[rowItems.length - 1].end : 0;

  const colItems = colVirt.getVirtualItems();
  const colTotal = colVirt.getTotalSize();
  const paddingLeft = colItems.length ? colItems[0].start : 0;
  const paddingRight = colItems.length ? colTotal - colItems[colItems.length - 1].end : 0;

  return (
    <div
      ref={scrollRef}
      className="relative max-h-[70vh] overflow-auto rounded-md border [contain:strict] [overscroll-behavior:contain]"
      style={{ willChange: "scroll-position" }}
    >
      <table className="border-collapse text-xs" style={{ width: 160 + colTotal }}>
        <thead className="sticky top-0 z-20 bg-card shadow-[0_1px_0_0_hsl(var(--border))]">
          <tr>
            <th className="sticky left-0 z-30 bg-card p-2 text-left font-medium" style={{ width: 160 }}>Theatre</th>
            {paddingLeft > 0 && <th aria-hidden style={{ width: paddingLeft }} />}
            {colItems.map((c) => {
              const d = days[c.index];
              return (
                <th key={c.key} colSpan={2} className="border-l p-2 text-center font-medium" style={{ width: c.size }}>
                  {weekdayShort(d)} <span className="text-muted-foreground">{formatDateGB(isoDate(d)).slice(0, 5)}</span>
                </th>
              );
            })}
            {paddingRight > 0 && <th aria-hidden style={{ width: paddingRight }} />}
          </tr>
          <tr className="text-[10px] uppercase text-muted-foreground">
            <th className="sticky left-0 z-30 bg-card" style={{ width: 160 }}></th>
            {paddingLeft > 0 && <th aria-hidden style={{ width: paddingLeft }} />}
            {colItems.flatMap((c) =>
              SESSIONS.map((s) => (
                <th key={`${c.key}-${s}`} className="border-l p-1 text-center font-medium" style={{ width: c.size / 2 }}>
                  {s}
                </th>
              )),
            )}
            {paddingRight > 0 && <th aria-hidden style={{ width: paddingRight }} />}
          </tr>
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden style={{ height: paddingTop }}>
              <td colSpan={1 + 2 + colItems.length * 2} />
            </tr>
          )}
          {rowItems.map((v) => {
            const t = theatres[v.index];
            return (
              <tr
                key={t.id}
                ref={rowVirt.measureElement}
                data-index={v.index}
                className="border-t align-top"
              >
                <td className="sticky left-0 z-10 bg-card p-2 align-top font-medium" style={{ width: 160 }}>
                  {t.name}
                  <div className="text-[10px] uppercase text-muted-foreground">{t.kind}</div>
                </td>
                {paddingLeft > 0 && <td aria-hidden style={{ width: paddingLeft }} />}
                {colItems.flatMap((c) => {
                  const date = isoDate(days[c.index]);
                  return SESSIONS.map((s) => {
                    const cell = cellIndex.get(`${t.id}|${date}|${s}`);
                    return (
                      <td key={`${date}-${s}`} className="border-l p-1 align-top" style={{ width: c.size / 2 }}>
                        <Cell
                          cell={cell}
                          theatreId={t.id}
                          date={date}
                          session={s}
                          theatreKind={t.kind}
                          specialties={specialties}
                          onChange={(patch) => onUpsert(t.id, date, s, cell, patch)}
                          onClear={() => cell && onRemove(cell.id)}
                        />
                      </td>
                    );
                  });
                })}
                {paddingRight > 0 && <td aria-hidden style={{ width: paddingRight }} />}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden style={{ height: paddingBottom }}>
              <td colSpan={1 + 2 + colItems.length * 2} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function Cell({
  cell, theatreId, date, session, theatreKind, specialties, onChange, onClear,
}: {
  cell: SessionRow | undefined;
  theatreId: string;
  date: string;
  session: Sess;
  theatreKind: "main" | "day_surgery" | "private";
  specialties: { id: string; name: string }[];
  onChange: (patch: SessionPatch) => void;
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
      {theatreKind === "private" && (
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground"
          title="Mark this NHH list as non-SAG (NHS job-planned)."
        >
          <input
            type="checkbox"
            className="h-3 w-3 accent-amber-500"
            checked={cell?.is_non_sag ?? false}
            onChange={(e) => onChange({ is_non_sag: e.target.checked })}
          />
          <span className={cell?.is_non_sag ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
            Non-SAG
          </span>
        </label>
      )}

    </div>
  );
}
