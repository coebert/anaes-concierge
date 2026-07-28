import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { listActiveStaffSafe } from "@/features/staff/staff-directory.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { formatDateWithWeekdayGB, parseDateLocal, toISODateLocal } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/tutorials")({
  component: TutorialsAuditPage,
  head: () => ({
    meta: [
      { title: "Tutorials audit — Anaesthetics Concierge" },
      {
        name: "description",
        content:
          "Audit consultant and SAS tutorial sessions delivered in the department, identified from CLWRota.",
      },
      { property: "og:title", content: "Tutorials audit" },
      {
        property: "og:description",
        content:
          "See which staff delivered tutorial sessions, on which dates, and drill into individual sessions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Grade = "consultant" | "sas" | "trainee" | null;
type Session = "am" | "pm" | "eve" | "night";

interface TutorialRow {
  id: string;
  staff_id: string;
  session_date: string;
  session: Session;
  notes: string | null;
  role_on_list: string;
  clwrota_external_id: string | null;
  source: string;
  locally_modified: boolean;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toISODateLocal(d);
}

function TutorialsAuditPage() {
  const [rangeDays, setRangeDays] = useState<number>(180);
  const [gradeFilter, setGradeFilter] = useState<"all" | "consultant" | "sas" | "trainee">(
    "all",
  );
  const [search, setSearch] = useState("");

  const startIso = useMemo(() => isoDaysAgo(rangeDays), [rangeDays]);
  const endIso = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return toISODateLocal(d);
  }, []);

  const listActive = useServerFn(listActiveStaffSafe);
  const { data: staff } = useQuery({
    queryKey: ["staff-active-tutorials"],
    queryFn: () => listActive(),
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: ["tutorials", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select(
          "id,staff_id,session_date,session,notes,role_on_list,clwrota_external_id,source,locally_modified",
        )
        .eq("duty_type", "teaching")
        .ilike("notes", "Tutorial:%")
        .gte("session_date", startIso)
        .lte("session_date", endIso)
        .order("session_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TutorialRow[];
    },
  });

  const staffMap = useMemo(() => {
    const m = new Map<string, { full_name: string; grade: Grade }>();
    for (const s of staff ?? []) m.set(s.id, { full_name: s.full_name ?? "—", grade: (s.grade ?? null) as Grade });
    return m;
  }, [staff]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      const sp = staffMap.get(r.staff_id);
      if (gradeFilter !== "all" && sp?.grade !== gradeFilter) return false;
      if (!q) return true;
      const hay = `${sp?.full_name ?? ""} ${r.notes ?? ""} ${r.session_date}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, staffMap, gradeFilter, search]);

  // Per-staff summary — count sessions delivered in the window.
  const perStaff = useMemo(() => {
    const m = new Map<string, { staff_id: string; name: string; grade: Grade; count: number }>();
    for (const r of filtered) {
      const sp = staffMap.get(r.staff_id);
      const key = r.staff_id;
      const entry =
        m.get(key) ??
        { staff_id: key, name: sp?.full_name ?? "—", grade: sp?.grade ?? null, count: 0 };
      entry.count += 1;
      m.set(key, entry);
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [filtered, staffMap]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Tutorials audit</h1>
        <p className="text-muted-foreground text-sm">
          Tutorial, lecture and departmental teaching sessions identified from CLWRota. Rows are
          matched by the CLWRota role / label containing "tutorial", "tutor", "lecture" or
          "departmental teaching".
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Time window</label>
            <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(Number(v))}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="180">Last 6 months</SelectItem>
                <SelectItem value="365">Last 12 months</SelectItem>
                <SelectItem value="1095">Last 3 years</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Grade</label>
            <Select value={gradeFilter} onValueChange={(v) => setGradeFilter(v as typeof gradeFilter)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All grades</SelectItem>
                <SelectItem value="consultant">Consultants</SelectItem>
                <SelectItem value="sas">SAS</SelectItem>
                <SelectItem value="trainee">Trainees</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 flex-1 min-w-[200px]">
            <label className="text-xs text-muted-foreground">Search</label>
            <Input
              placeholder="Search by name or notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            By staff member ({perStaff.length} staff · {filtered.length} sessions)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Staff</th>
                <th className="p-2">Grade</th>
                <th className="p-2 text-right">Sessions delivered</th>
              </tr>
            </thead>
            <tbody>
              {perStaff.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-muted-foreground">
                    {isLoading ? "Loading…" : "No tutorial sessions in this window."}
                  </td>
                </tr>
              )}
              {perStaff.map((p) => (
                <tr key={p.staff_id} className="border-t">
                  <td className="p-2 font-medium">{p.name}</td>
                  <td className="p-2 capitalize text-muted-foreground">{p.grade ?? "—"}</td>
                  <td className="p-2 text-right tabular-nums">{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Session log</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Date</th>
                <th className="p-2">Session</th>
                <th className="p-2">Staff</th>
                <th className="p-2">Grade</th>
                <th className="p-2">Label</th>
                <th className="p-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-muted-foreground">
                    {isLoading ? "Loading…" : "No sessions match the current filters."}
                  </td>
                </tr>
              )}
              {filtered.map((r) => {
                const sp = staffMap.get(r.staff_id);
                const d = parseDateLocal(r.session_date);
                return (
                  <tr key={r.id} className="border-t">
                    <td className="p-2 whitespace-nowrap">{d ? formatDateWithWeekdayGB(d) : r.session_date}</td>
                    <td className="p-2 uppercase text-xs">{r.session}</td>
                    <td className="p-2 font-medium">{sp?.full_name ?? "—"}</td>
                    <td className="p-2 capitalize text-muted-foreground">{sp?.grade ?? "—"}</td>
                    <td className="p-2">{r.notes ?? "—"}</td>
                    <td className="p-2">
                      <Badge variant={r.locally_modified ? "outline" : "secondary"}>
                        {r.locally_modified ? "Locally edited" : r.source}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
