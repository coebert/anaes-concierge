import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { StaffEditDialog } from "@/components/staff-edit-dialog";
import { Pencil } from "lucide-react";
import { formatDateGB } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/job-plans")({
  component: JobPlansPage,
});

const TITLE_TOKENS = new Set([
  "dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "miss",
  "prof", "prof.", "professor", "mx", "mx.", "sir", "dame",
]);

function splitName(full: string | null | undefined): {
  title: string;
  firstName: string;
  surname: string;
} {
  const raw = (full ?? "").trim();
  if (!raw) return { title: "", firstName: "", surname: "" };
  // Support "Surname, First" format
  if (raw.includes(",")) {
    const [last, rest] = raw.split(",", 2).map((s) => s.trim());
    const parts = (rest ?? "").split(/\s+/).filter(Boolean);
    let title = "";
    if (parts.length && TITLE_TOKENS.has(parts[0].toLowerCase())) {
      title = parts.shift()!;
    }
    return { title, firstName: parts.join(" "), surname: last };
  }
  const parts = raw.split(/\s+/);
  let title = "";
  if (parts.length > 1 && TITLE_TOKENS.has(parts[0].toLowerCase())) {
    title = parts.shift()!;
  }
  if (parts.length === 0) return { title, firstName: "", surname: "" };
  if (parts.length === 1) return { title, firstName: "", surname: parts[0] };
  const surname = parts.pop()!;
  return { title, firstName: parts.join(" "), surname };
}

function JobPlansPage() {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["job-plans-overview"],
    queryFn: async () => {
      const { data: profiles, error: e1 } = await supabase
        .from("profiles")
        .select("id,full_name,email,grade,training_level,active")
        .eq("active", true)
        .order("full_name");
      if (e1) throw e1;

      const ids = (profiles ?? []).map((p) => p.id);
      const [{ data: jps }, { data: fixed }] = await Promise.all([
        supabase.from("job_plans").select("*").in("staff_id", ids),
        supabase.from("fixed_sessions").select("staff_id").in("staff_id", ids),
      ]);

      const latestJp = new Map<string, typeof jps extends (infer T)[] | null ? T : never>();
      for (const jp of jps ?? []) {
        const cur = latestJp.get(jp.staff_id);
        if (!cur || jp.valid_from > cur.valid_from) latestJp.set(jp.staff_id, jp);
      }
      const fixedCount = new Map<string, number>();
      for (const f of fixed ?? []) {
        fixedCount.set(f.staff_id, (fixedCount.get(f.staff_id) ?? 0) + 1);
      }

      return (profiles ?? []).map((p) => ({
        ...p,
        ...splitName(p.full_name),
        jp: latestJp.get(p.id) ?? null,
        fixed: fixedCount.get(p.id) ?? 0,
      })).sort((a, b) =>
        (a.surname || a.email || "").localeCompare(b.surname || b.email || "") ||
        (a.firstName || "").localeCompare(b.firstName || ""),
      );
    },
  });

  const filtered = data?.filter((p) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      p.full_name?.toLowerCase().includes(q) ||
      p.email?.toLowerCase().includes(q) ||
      p.grade?.toLowerCase().includes(q) ||
      p.surname?.toLowerCase().includes(q) ||
      p.firstName?.toLowerCase().includes(q) ||
      p.title?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Job plans</h1>
          <p className="text-sm text-muted-foreground">
            PAs per week, LTFT and fixed sessions for every active staff member.
          </p>
        </div>
        <Input
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All active staff</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !filtered?.length ? (
            <p className="text-sm text-muted-foreground">No staff found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Surname</TableHead>
                  <TableHead>First name</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Total PAs</TableHead>
                  <TableHead className="text-right">DCC</TableHead>
                  <TableHead className="text-right">SPA</TableHead>
                  <TableHead>LTFT</TableHead>
                  <TableHead className="text-right">Fixed</TableHead>
                  <TableHead>Valid from</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-muted-foreground">
                      {p.title || "—"}
                    </TableCell>
                    <TableCell className="font-medium">
                      {p.surname || (!p.firstName ? p.email : "—")}
                    </TableCell>
                    <TableCell>
                      {p.firstName || "—"}
                      {p.training_level && (
                        <Badge variant="secondary" className="ml-2">{p.training_level}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {p.grade ? <Badge variant="outline">{p.grade}</Badge> : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.jp ? Number(p.jp.total_pas) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.jp ? Number(p.jp.dcc_pas) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.jp ? Number(p.jp.spa_pas) : "—"}
                    </TableCell>
                    <TableCell>
                      {p.jp?.ltft ? (
                        <Badge>{p.jp.ltft_percentage ?? ""}%</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">FT</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.fixed}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDateGB(p.jp?.valid_from)}
                    </TableCell>
                    <TableCell>
                      <Button size="icon" variant="ghost" onClick={() => setEditingId(p.id)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <StaffEditDialog
        staffId={editingId}
        open={!!editingId}
        onOpenChange={(o) => !o && setEditingId(null)}
      />
    </div>
  );
}
