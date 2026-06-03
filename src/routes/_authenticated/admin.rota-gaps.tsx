import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  computeRotaGaps, classifyRotaGaps, GAP_KIND_LABEL,
  type GapRange, type ClassifiedGapRange, type GapKind,
} from "@/lib/rota-gaps";
import { compareBySurnameAsc, formatDateGB, todayISO } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, CalendarX } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/rota-gaps")({
  component: RotaGapsPage,
});

type WindowChoice = "30" | "90" | "180" | "rotation";
const WINDOW_LABEL: Record<WindowChoice, string> = {
  "30": "Last 30 days",
  "90": "Last 90 days",
  "180": "Last 6 months",
  rotation: "Full rotation",
};

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function RotaGapsPage() {
  const { hasRole, loading } = useAuth();
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("90");
  const [filter, setFilter] = useState("");
  const [hideClean, setHideClean] = useState(true);

  const { data, isLoading } = useQuery({
    queryKey: ["rota-gaps", windowChoice],
    queryFn: async () => {
      const today = todayISO();
      const since =
        windowChoice === "rotation"
          ? null
          : addDaysISO(today, -parseInt(windowChoice));

      const { data: trainees, error: e1 } = await supabase
        .from("profiles")
        .select("id, full_name, training_level, start_date, rotation_end_date, ltft_days_off")
        .eq("grade", "trainee")
        .eq("active", true)
        .order("full_name");
      if (e1) throw e1;

      const ids = (trainees ?? []).map((t) => t.id);
      if (!ids.length) return { trainees: [], datesByStaff: new Map<string, Set<string>>(), today };

      // Paginate to avoid the 1000-row server cap.
      const PAGE = 1000;
      const all: Array<{ staff_id: string; session_date: string }> = [];
      let offset = 0;
      while (true) {
        let q = supabase
          .from("rota_assignments")
          .select("staff_id, session_date")
          .in("staff_id", ids)
          .order("session_date", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (since) q = q.gte("session_date", since);
        const { data: page, error: e2 } = await q;
        if (e2) throw e2;
        const rows = page ?? [];
        all.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
        if (offset > 50_000) break;
      }

      const datesByStaff = new Map<string, Set<string>>();
      for (const r of all) {
        let set = datesByStaff.get(r.staff_id);
        if (!set) {
          set = new Set();
          datesByStaff.set(r.staff_id, set);
        }
        set.add(r.session_date);
      }
      return { trainees: trainees ?? [], datesByStaff, today, since };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const today = data.today;
    return data.trainees
      .map((t) => {
        const dates = data.datesByStaff.get(t.id) ?? new Set<string>();
        // Window = max(rotation start, lookback start) → min(rotation end, today)
        const lookbackStart = data.since ?? t.start_date ?? today;
        const startISO = [t.start_date ?? lookbackStart, lookbackStart]
          .sort()
          .reverse()[0]; // later of the two
        const endISO = [t.rotation_end_date ?? today, today].sort()[0]; // earlier of the two
        const ltft = (t.ltft_days_off ?? []) as number[];
        const report = computeRotaGaps(dates, startISO, endISO, ltft);
        // Classification uses the full audit window (lookback → today) so
        // pre-rotation and rotation-ended days appear as their own buckets
        // rather than being silently clipped.
        const auditStart = data.since ?? t.start_date ?? today;
        const classified = classifyRotaGaps(
          dates,
          auditStart,
          today,
          t.start_date ?? null,
          t.rotation_end_date ?? null,
          ltft,
        );
        return { trainee: t, report, classified };
      })
      .filter((r) => {
        if (filter) {
          const q = filter.toLowerCase();
          const match =
            r.trainee.full_name?.toLowerCase().includes(q) ||
            r.trainee.training_level?.toLowerCase().includes(q);
          if (!match) return false;
        }
        if (hideClean && r.report.totalMissingDays === 0) return false;
        return true;
      })
      .sort((a, b) => {
        const diff = b.report.totalMissingDays - a.report.totalMissingDays;
        if (diff !== 0) return diff;
        return compareBySurnameAsc(a.trainee.full_name, b.trainee.full_name);
      });
  }, [data, filter, hideClean]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!hasRole("admin")) return <Navigate to="/" />;

  const traineesWithGaps = rows.filter((r) => r.report.totalMissingDays > 0).length;
  const totalGapDays = rows.reduce((sum, r) => sum + r.report.totalMissingDays, 0);
  const totalRanges = rows.reduce((sum, r) => sum + r.report.ranges.length, 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rota gaps</h1>
          <p className="text-sm text-muted-foreground">
            Working weekdays inside each trainee's rotation where no rota assignment was synced.
            Contiguous gaps — including spans bridged by weekends or LTFT off days — are grouped into ranges.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-44">
            <label className="mb-1 block text-xs text-muted-foreground">Window</label>
            <Select value={windowChoice} onValueChange={(v) => setWindowChoice(v as WindowChoice)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(WINDOW_LABEL) as WindowChoice[]).map((k) => (
                  <SelectItem key={k} value={k}>{WINDOW_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-xs"
          />
          <label className="flex items-center gap-1 pb-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={hideClean}
              onChange={(e) => setHideClean(e.target.checked)}
            />
            Hide trainees with no gaps
          </label>
        </div>
      </header>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Scanning rotas…</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={AlertTriangle} tone="bad" label="Trainees with gaps" value={traineesWithGaps} />
            <Stat icon={CalendarX} tone="bad" label="Missing weekdays" value={totalGapDays} />
            <Stat icon={CalendarX} tone="muted" label="Distinct gap ranges" value={totalRanges} />
          </div>

          {rows.length === 0 ? (
            <Card>
              <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                {hideClean
                  ? "No trainees with missing days in this window."
                  : "No trainees match the current filter."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map(({ trainee, report, classified }) => (
                <Card key={trainee.id}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">
                        <Link
                          to="/trainees/$staffId"
                          params={{ staffId: trainee.id }}
                          className="hover:underline"
                        >
                          {trainee.full_name || "—"}
                        </Link>
                        {trainee.training_level && (
                          <Badge variant="secondary" className="ml-2">{trainee.training_level}</Badge>
                        )}
                      </CardTitle>
                      <div className="flex items-center gap-2 text-sm">
                        {report.totalMissingDays === 0 ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">No gaps</Badge>
                        ) : (
                          <Badge variant="destructive">
                            {report.totalMissingDays} of {report.totalExpectedDays} weekdays missing
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Window {formatDateGB(report.windowStartISO)} → {formatDateGB(report.windowEndISO)}
                    </p>
                  </CardHeader>
                  {report.ranges.length > 0 && (
                    <CardContent>
                      <ul className="divide-y rounded-md border">
                        {report.ranges.map((r) => (
                          <GapRangeRow key={`${r.startISO}-${r.endISO}`} range={r} />
                        ))}
                      </ul>
                    </CardContent>
                  )}
                  <ClassifiedSection report={classified} />
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GapRangeRow({ range }: { range: GapRange }) {
  const single = range.startISO === range.endISO;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <span className="font-mono">
        {single
          ? formatDateGB(range.startISO)
          : `${formatDateGB(range.startISO)} → ${formatDateGB(range.endISO)}`}
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {range.missingDays} working day{range.missingDays === 1 ? "" : "s"}
        </span>
        {!single && (
          <Badge variant="outline" className="px-1 py-0 text-[10px]">
            {range.spanDays}-day span
          </Badge>
        )}
      </span>
    </li>
  );
}

function Stat({
  icon: Icon, tone, label, value,
}: {
  icon: typeof CheckCircle2;
  tone: "ok" | "bad" | "muted";
  label: string;
  value: number;
}) {
  const toneClass =
    tone === "ok"
      ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
      : tone === "bad"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-md ${toneClass}`}>
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

const KIND_TONE: Record<GapKind, string> = {
  pre_rotation: "bg-muted text-muted-foreground",
  rotation_ended: "bg-muted text-muted-foreground",
  ltft_off: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  sync_missing: "bg-destructive/10 text-destructive",
};

function ClassifiedSection({
  report,
}: {
  report: ReturnType<typeof classifyRotaGaps>;
}) {
  const total =
    report.counts.pre_rotation +
    report.counts.rotation_ended +
    report.counts.ltft_off +
    report.counts.sync_missing;
  if (total === 0) return null;
  return (
    <CardContent className="border-t pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-muted-foreground">Classification:</span>
        {(Object.keys(GAP_KIND_LABEL) as GapKind[]).map((k) => (
          <Badge key={k} variant="outline" className={`gap-1 ${KIND_TONE[k]}`}>
            {GAP_KIND_LABEL[k]}: {report.counts[k]}
          </Badge>
        ))}
      </div>
      {report.ranges.length > 0 && (
        <ul className="divide-y rounded-md border">
          {report.ranges.map((r) => (
            <ClassifiedRangeRow key={`${r.kind}-${r.startISO}-${r.endISO}`} range={r} />
          ))}
        </ul>
      )}
    </CardContent>
  );
}

function ClassifiedRangeRow({ range }: { range: ClassifiedGapRange }) {
  const single = range.startISO === range.endISO;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <Badge variant="outline" className={`px-1 py-0 text-[10px] ${KIND_TONE[range.kind]}`}>
          {GAP_KIND_LABEL[range.kind]}
        </Badge>
        <span className="font-mono">
          {single
            ? formatDateGB(range.startISO)
            : `${formatDateGB(range.startISO)} → ${formatDateGB(range.endISO)}`}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {range.days} day{range.days === 1 ? "" : "s"}
      </span>
    </li>
  );
}
