import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { listStaffForAdmin } from "@/lib/admin-staff.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { StaffEditDialog } from "@/components/staff-edit-dialog";
import { AddStaffDialog } from "@/components/add-staff-dialog";
import { Pencil, UserPlus } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { todayISO } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/staff")({
  component: AdminStaffPage,
});

type StaffWithPlan = {
  id: string;
  email: string;
  full_name: string | null;
  grade: string | null;
  training_level: string | null;
  active: boolean | null;
  job_plan: { total_pas: number; ltft: boolean; ltft_percentage: number | null } | null;
};

function getSurname(fullName: string | null): string {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

function sortBySurnameDesc(a: StaffWithPlan, b: StaffWithPlan): number {
  const aSurname = getSurname(a.full_name).toLowerCase();
  const bSurname = getSurname(b.full_name).toLowerCase();
  if (aSurname < bSurname) return 1;
  if (aSurname > bSurname) return -1;
  return 0;
}

function StaffGroup({
  title,
  staff,
  onEdit,
}: {
  title: string;
  staff: StaffWithPlan[];
  onEdit: (id: string) => void;
}) {
  if (!staff.length) return null;
  const sorted = [...staff].sort(sortBySurnameDesc);
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title} ({staff.length})
      </h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Details</TableHead>
            <TableHead>LTFT</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-16"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.full_name || "—"}</TableCell>
              <TableCell className="text-muted-foreground">{p.email}</TableCell>
              <TableCell>
                {p.grade === "consultant" && p.job_plan ? (
                  <span className="text-sm">{p.job_plan.total_pas} PAs</span>
                ) : p.grade === "trainee" && p.training_level ? (
                  <Badge variant="secondary">{p.training_level}</Badge>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                {p.job_plan?.ltft ? (
                  <Badge>{p.job_plan.ltft_percentage ?? ""}%</Badge>
                ) : (
                  <span className="text-sm text-muted-foreground">Full time</span>
                )}
              </TableCell>
              <TableCell>
                {p.active ? (
                  <Badge variant="default">active</Badge>
                ) : (
                  <Badge variant="destructive">inactive</Badge>
                )}
              </TableCell>
              <TableCell>
                <Button size="icon" variant="ghost" onClick={() => onEdit(p.id)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AdminStaffPage() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);

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
      const now = todayISO();
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
    if (!showInactive && p.active === false) return false;
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
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="show-inactive"
              checked={showInactive}
              onCheckedChange={setShowInactive}
            />
            <Label htmlFor="show-inactive" className="cursor-pointer text-sm">
              Show inactive
            </Label>
          </div>
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-xs"
          />
          {isAdmin && (
            <Button onClick={() => setAddOpen(true)}>
              <UserPlus className="mr-2 h-4 w-4" /> Add staff
            </Button>
          )}
        </div>
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
            <div className="space-y-6">
              <StaffGroup
                title="Consultants"
                staff={filtered.filter((p) => p.grade === "consultant")}
                onEdit={(id) => setEditingId(id)}
              />
              <StaffGroup
                title="SAS Doctors"
                staff={filtered.filter((p) => p.grade === "sas")}
                onEdit={(id) => setEditingId(id)}
              />
              <StaffGroup
                title="Trainees"
                staff={filtered.filter((p) => p.grade === "trainee")}
                onEdit={(id) => setEditingId(id)}
              />
              <StaffGroup
                title="Other"
                staff={filtered.filter((p) => !p.grade || !["consultant", "sas", "trainee"].includes(p.grade))}
                onEdit={(id) => setEditingId(id)}
              />
            </div>
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
      <AddStaffDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
