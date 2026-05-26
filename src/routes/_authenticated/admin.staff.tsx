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

export const Route = createFileRoute("/_authenticated/admin/staff")({
  component: AdminStaffPage,
});

function AdminStaffPage() {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("id,email,full_name,grade,training_level,active")
        .order("full_name");
      if (error) throw error;
      const { data: jps } = await supabase
        .from("job_plans")
        .select("staff_id,total_pas,ltft,ltft_percentage,valid_from,valid_to");
      const now = new Date().toISOString().slice(0, 10);
      const jobPlanMap = new Map<string, { total_pas: number; ltft: boolean; ltft_percentage: number | null }>();
      for (const jp of jps ?? []) {
        if (jp.valid_from <= now && (!jp.valid_to || jp.valid_to >= now)) {
          jobPlanMap.set(jp.staff_id, {
            total_pas: Number(jp.total_pas),
            ltft: jp.ltft,
            ltft_percentage: jp.ltft_percentage ? Number(jp.ltft_percentage) : null,
          });
        }
      }
      return (profiles ?? []).map((p) => ({
        ...p,
        job_plan: jobPlanMap.get(p.id) ?? null,
      }));
    },
  });

  const filtered = data?.filter((p) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      p.full_name?.toLowerCase().includes(q) ||
      p.email?.toLowerCase().includes(q) ||
      p.grade?.toLowerCase().includes(q) ||
      p.training_level?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
          <p className="text-sm text-muted-foreground">
            Manage profiles, roles, job plans and fixed weekly sessions.
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
          <CardTitle className="text-base">All registered users</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !filtered?.length ? (
            <p className="text-sm text-muted-foreground">No staff records.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.full_name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{p.email}</TableCell>
                    <TableCell>
                      {p.grade ? <Badge variant="outline">{p.grade}</Badge> : "—"}
                    </TableCell>
                    <TableCell>
                      {p.training_level ? (
                        <Badge variant="secondary">{p.training_level}</Badge>
                      ) : "—"}
                    </TableCell>
                    <TableCell>
                      {p.active ? (
                        <Badge variant="default">active</Badge>
                      ) : (
                        <Badge variant="destructive">inactive</Badge>
                      )}
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
          <p className="mt-4 text-xs text-muted-foreground">
            New users appear here automatically when they sign up.
          </p>
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
