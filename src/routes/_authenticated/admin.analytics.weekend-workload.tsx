import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CalendarClock, Users } from "lucide-react";
import { splitName } from "@/lib/utils";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/weekend-workload",
)({
  head: () => ({
    meta: [
      { title: "Weekend workload (job plan) — HR analytics" },
      {
        name: "description",
        content:
          "Distinct Saturday and Sunday dates worked as job-planned sessions by permanent (non-trainee) staff over the rolling last 12 months.",
      },
    ],
  }),
  component: WeekendWorkloadPage,
});

const PAGE_SIZE = 1000;

type Row = {
  staff_id: string | null;
  session_date: string | null;
  is_non_sag: boolean | null;
  extra_type: string | null;
  theatre_sessions:
    | { is_non_sag: boolean | null; theatres: { kind: string | null } | null }
    | null;
};

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function isWeekend(isoDate: string) {
  // Use UTC noon to avoid TZ edge cases.
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function WeekendWorkloadPage() {
  const { hasRole, loading } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-weekend-workload"],
    queryFn: async () => {
      const since = isoDaysAgo(365);

      const { data: profiles, error: pErr } = await supabase
        .from("profiles")
        .select("id,full_name,grade,active")
        .eq("active", true)
        .in("grade", ["consultant", "sas"])
        .order("full_name");
      if (pErr) throw pErr;
      const staffIds = (profiles ?? []).map((p) => p.id);
      if (staffIds.length === 0) return { profiles: profiles ?? [], rows: [] as Row[] };

      // Chunked pagination — rota_assignments can easily exceed 1k rows/year.
      const rows: Row[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: page, error } = await supabase
          .from("rota_assignments")
          .select(
            "staff_id,session_date,is_non_sag,extra_type,theatre_sessions:theatre_session_id(is_non_sag,theatres:theatre_id(kind))",
          )
          .in("staff_id", staffIds)
          .gte("session_date", since)
          .is("extra_type", null)
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...((page ?? []) as unknown as Row[]));
        if (!page || page.length < PAGE_SIZE) break;
      }

      return { profiles: profiles ?? [], rows };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const nameById = new Map(
      data.profiles.map((p) => [p.id, p.full_name || "Unknown"]),
    );
    const gradeById = new Map(data.profiles.map((p) => [p.id, p.grade]));

    // staff_id -> Set of ISO dates that count as a job-planned weekend day.
    const weekendDatesByStaff = new Map<string, Set<string>>();

    for (const r of data.rows) {
      if (!r.staff_id || !r.session_date) continue;
      if (r.extra_type) continue; // extras/locum/WLI
      if (!isWeekend(r.session_date)) continue;

      // Exclude SAG (private) lists: theatre.kind === 'private' AND row is
      // NOT flagged non_sag. Non-SAG NHH cover stays in.
      const kind = r.theatre_sessions?.theatres?.kind ?? null;
      const rowNonSag = r.is_non_sag || r.theatre_sessions?.is_non_sag || false;
      if (kind === "private" && !rowNonSag) continue;

      let set = weekendDatesByStaff.get(r.staff_id);
      if (!set) {
        set = new Set<string>();
        weekendDatesByStaff.set(r.staff_id, set);
      }
      set.add(r.session_date);
    }

    const rows = Array.from(nameById.keys()).map((id) => {
      const dates = weekendDatesByStaff.get(id) ?? new Set<string>();
      let sat = 0;
      let sun = 0;
      for (const iso of dates) {
        const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
        if (dow === 6) sat++;
        else if (dow === 0) sun++;
      }
      return {
        staff_id: id,
        name: nameById.get(id) ?? "Unknown",
        grade: gradeById.get(id) ?? null,
        total: dates.size,
        sat,
        sun,
        ...splitName(nameById.get(id) ?? ""),
      };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    const totalDays = rows.reduce((n, r) => n + r.total, 0);
    const workedStaff = rows.filter((r) => r.total > 0).length;
    const mean = rows.length > 0 ? totalDays / rows.length : 0;

    return { rows, totalDays, workedStaff, mean };
  }, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading || !view) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Weekend workload (job plan)"
        description="Distinct Saturday and Sunday dates worked by permanent (non-trainee) staff over the rolling last 12 months. Excludes shifts flagged as extra, locum, WLI, and SAG (private) lists; non-SAG NHH cover is counted as job-planned."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Permanent staff" value={view.rows.length} icon={Users} />
        <StatCard label="Worked ≥1 weekend day" value={view.workedStaff} icon={Users} />
        <StatCard label="Total weekend days" value={view.totalDays} icon={CalendarClock} />
        <StatCard label="Mean per staff member" value={view.mean.toFixed(1)} icon={CalendarClock} />
      </div>
      <Card>
        <CardContent className="p-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Staff</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Saturdays</TableHead>
                <TableHead className="text-right">Sundays</TableHead>
                <TableHead className="text-right">Total weekend days</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rows.map((r) => (
                <TableRow key={r.staff_id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    {r.grade ? <Badge variant="outline">{r.grade}</Badge> : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.sat}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.sun}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">
                    {r.total}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
