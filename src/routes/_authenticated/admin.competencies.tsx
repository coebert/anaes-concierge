import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, Plus, Check } from "lucide-react";
import { toast } from "sonner";
import { compareBySurname } from "@/lib/name-sort";
import type {
  Competency, CompetencyCategory, StaffCompetency, CompetencyRequirement,
  RequirementLevel, CompetencyRequirementRole, CompetencyLevel,
} from "@/features/competencies/competencies";

export const Route = createFileRoute("/_authenticated/admin/competencies")({
  head: () => ({
    meta: [{ title: "Competency register — Salisbury Anaesthetics Rota" }],
  }),
  component: CompetenciesGuard,
});

function CompetenciesGuard() {
  const { hasRole, loading } = useAuth();
  if (loading) return null;
  if (!hasRole("admin")) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Only administrators can manage the competency register.
        </CardContent>
      </Card>
    );
  }
  return <CompetenciesPage />;
}

const CATEGORIES: { value: CompetencyCategory; label: string }[] = [
  { value: "subspecialty", label: "Subspecialty" },
  { value: "procedural", label: "Procedural" },
  { value: "lead_role", label: "Lead role" },
  { value: "transfer", label: "Transfer" },
  { value: "training", label: "Training (solo per specialty)" },
  { value: "other", label: "Other" },
];

function CompetenciesPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Competency register"
        description="Who is signed off for what. Warnings appear in the rota editor when someone is assigned to a list they lack the competency for."
      />
      <Tabs defaultValue="catalogue">
        <TabsList>
          <TabsTrigger value="catalogue">Catalogue</TabsTrigger>
          <TabsTrigger value="requirements">Specialty requirements</TabsTrigger>
          <TabsTrigger value="signoffs">Staff sign-offs</TabsTrigger>
        </TabsList>
        <TabsContent value="catalogue" className="mt-4"><CatalogueTab /></TabsContent>
        <TabsContent value="requirements" className="mt-4"><RequirementsTab /></TabsContent>
        <TabsContent value="signoffs" className="mt-4"><SignoffsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// Catalogue tab
// ============================================================

function useCompetencies() {
  return useQuery({
    queryKey: ["competencies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("competencies")
        .select("id,code,name,description,category,applies_to_grades,active,sort_order")
        .order("sort_order").order("name");
      if (error) throw error;
      return (data ?? []) as Competency[];
    },
  });
}

function CatalogueTab() {
  const qc = useQueryClient();
  const { data: comps } = useCompetencies();
  const [form, setForm] = useState({
    code: "", name: "", description: "", category: "subspecialty" as CompetencyCategory,
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!form.code || !form.name) throw new Error("Code and name are required.");
      const { error } = await supabase.from("competencies").insert({
        code: form.code, name: form.name,
        description: form.description || null, category: form.category,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Competency added");
      setForm({ code: "", name: "", description: "", category: "subspecialty" });
      qc.invalidateQueries({ queryKey: ["competencies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async (c: Competency) => {
      const { error } = await supabase
        .from("competencies").update({ active: !c.active }).eq("id", c.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["competencies"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("competencies").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["competencies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Add competency</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-5">
          <div className="space-y-1.5">
            <Label className="text-xs">Code</Label>
            <Input value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. difficult_airway_lead" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Name</Label>
            <Input value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Difficult airway lead" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <Select value={form.category}
              onValueChange={(v) => setForm({ ...form, category: v as CompetencyCategory })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 flex flex-col justify-end">
            <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
              <Plus className="mr-1 h-4 w-4" />Add
            </Button>
          </div>
          <div className="space-y-1.5 sm:col-span-5">
            <Label className="text-xs">Description (optional)</Label>
            <Input value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Short description shown as tooltip in the picker" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Catalogue</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Grades</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(comps ?? []).map((c) => (
                <TableRow key={c.id} className={c.active ? "" : "opacity-50"}>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell>
                    <div>{c.name}</div>
                    {c.description && (
                      <div className="text-xs text-muted-foreground">{c.description}</div>
                    )}
                  </TableCell>
                  <TableCell><Badge variant="outline">{c.category}</Badge></TableCell>
                  <TableCell className="text-xs">{c.applies_to_grades.join(", ")}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost"
                      onClick={() => toggleActive.mutate(c)}>
                      {c.active ? "Retire" : "Reactivate"}
                    </Button>
                    <Button size="icon" variant="ghost"
                      onClick={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id); }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(!comps || comps.length === 0) && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No competencies yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Requirements tab
// ============================================================

function RequirementsTab() {
  const qc = useQueryClient();
  const { data: comps } = useCompetencies();

  const { data: specialties } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties").select("id,name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: reqs } = useQuery({
    queryKey: ["specialty-competency-requirements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialty_competency_requirements")
        .select("id,specialty_id,competency_id,requirement,applies_to_role");
      if (error) throw error;
      return (data ?? []) as CompetencyRequirement[];
    },
  });

  const [form, setForm] = useState({
    specialty_id: "",
    competency_id: "",
    requirement: "required" as RequirementLevel,
    applies_to_role: "solo" as CompetencyRequirementRole,
  });

  const add = useMutation({
    mutationFn: async () => {
      if (!form.specialty_id || !form.competency_id) {
        throw new Error("Pick a specialty and a competency.");
      }
      const { error } = await supabase
        .from("specialty_competency_requirements").insert(form);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Requirement added");
      setForm({ ...form, competency_id: "" });
      qc.invalidateQueries({ queryKey: ["specialty-competency-requirements"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("specialty_competency_requirements").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["specialty-competency-requirements"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const specById = useMemo(
    () => new Map((specialties ?? []).map((s) => [s.id, s.name])),
    [specialties],
  );
  const compById = useMemo(
    () => new Map((comps ?? []).map((c) => [c.id, c])),
    [comps],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Add requirement</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-5">
          <div className="space-y-1.5">
            <Label className="text-xs">Specialty</Label>
            <Select value={form.specialty_id}
              onValueChange={(v) => setForm({ ...form, specialty_id: v })}>
              <SelectTrigger><SelectValue placeholder="Pick specialty" /></SelectTrigger>
              <SelectContent>
                {(specialties ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Competency</Label>
            <Select value={form.competency_id}
              onValueChange={(v) => setForm({ ...form, competency_id: v })}>
              <SelectTrigger><SelectValue placeholder="Pick competency" /></SelectTrigger>
              <SelectContent>
                {(comps ?? []).filter((c) => c.active).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Requirement</Label>
            <Select value={form.requirement}
              onValueChange={(v) => setForm({ ...form, requirement: v as RequirementLevel })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="required">Required</SelectItem>
                <SelectItem value="recommended">Recommended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Applies to role</Label>
            <Select value={form.applies_to_role}
              onValueChange={(v) => setForm({ ...form, applies_to_role: v as CompetencyRequirementRole })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="solo">Solo</SelectItem>
                <SelectItem value="supervising">Supervising</SelectItem>
                <SelectItem value="any">Any role</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-5">
            <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending}>
              <Plus className="mr-1 h-4 w-4" />Add requirement
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Current requirements</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Specialty</TableHead>
                <TableHead>Competency</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(reqs ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{specById.get(r.specialty_id) ?? "—"}</TableCell>
                  <TableCell>{compById.get(r.competency_id)?.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={r.requirement === "required" ? "default" : "outline"}>
                      {r.requirement}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{r.applies_to_role}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" onClick={() => remove.mutate(r.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(!reqs || reqs.length === 0) && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No requirements yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Sign-offs tab
// ============================================================

function SignoffsTab() {
  const qc = useQueryClient();
  const { data: comps } = useCompetencies();

  const { data: staff } = useQuery({
    queryKey: ["staff-active-min"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade,training_level")
        .eq("active", true).order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: holdings } = useQuery({
    queryKey: ["staff-competencies-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_competencies")
        .select("id,staff_id,competency_id,level,granted_at,expires_at,revoked_at,notes");
      if (error) throw error;
      return (data ?? []) as StaffCompetency[];
    },
  });

  const [staffId, setStaffId] = useState<string>("");
  const [form, setForm] = useState({
    competency_id: "",
    level: "" as "" | CompetencyLevel,
    granted_at: new Date().toISOString().slice(0, 10),
    expires_at: "",
    notes: "",
  });

  const add = useMutation({
    mutationFn: async () => {
      if (!staffId) throw new Error("Pick a staff member first.");
      if (!form.competency_id) throw new Error("Pick a competency.");
      const { error } = await supabase.from("staff_competencies").insert({
        staff_id: staffId,
        competency_id: form.competency_id,
        level: form.level || null,
        granted_at: form.granted_at,
        expires_at: form.expires_at || null,
        notes: form.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Sign-off recorded");
      setForm({ ...form, competency_id: "", notes: "", expires_at: "" });
      qc.invalidateQueries({ queryKey: ["staff-competencies-all"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("staff_competencies")
        .update({ revoked_at: new Date().toISOString().slice(0, 10) })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-competencies-all"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const unrevoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("staff_competencies").update({ revoked_at: null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-competencies-all"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("staff_competencies").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-competencies-all"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const staffHoldings = useMemo(
    () => (holdings ?? []).filter((h) => h.staff_id === staffId),
    [holdings, staffId],
  );

  const compById = useMemo(
    () => new Map((comps ?? []).map((c) => [c.id, c])),
    [comps],
  );

  const currentStaff = staff?.find((s) => s.id === staffId);
  const eligibleComps = useMemo(() => {
    if (!currentStaff) return [];
    return (comps ?? []).filter(
      (c) => c.active
        && c.applies_to_grades.includes(currentStaff.grade ?? "")
        && !staffHoldings.some((h) => h.competency_id === c.id && !h.revoked_at),
    );
  }, [comps, currentStaff, staffHoldings]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Record sign-off</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Staff member</Label>
            <Select value={staffId} onValueChange={setStaffId}>
              <SelectTrigger className="max-w-md"><SelectValue placeholder="Pick staff" /></SelectTrigger>
              <SelectContent>
                {(staff ?? [])
                  .slice()
                  .sort((a, b) => compareBySurname(a.full_name, b.full_name))
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.full_name} {s.grade ? `(${s.grade}${s.training_level ? " " + s.training_level : ""})` : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {staffId && (
            <div className="grid gap-3 sm:grid-cols-6">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Competency</Label>
                <Select value={form.competency_id}
                  onValueChange={(v) => setForm({ ...form, competency_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Pick competency" /></SelectTrigger>
                  <SelectContent>
                    {eligibleComps.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Level</Label>
                <Select value={form.level || "unspecified"}
                  onValueChange={(v) => setForm({ ...form, level: v === "unspecified" ? "" : v as CompetencyLevel })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unspecified">Unspecified</SelectItem>
                    <SelectItem value="independent">Independent</SelectItem>
                    <SelectItem value="supervised">Supervised</SelectItem>
                    <SelectItem value="aware">Aware</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Granted</Label>
                <Input type="date" value={form.granted_at}
                  onChange={(e) => setForm({ ...form, granted_at: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Expires (optional)</Label>
                <Input type="date" value={form.expires_at}
                  onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
              </div>
              <div className="space-y-1.5 flex flex-col justify-end">
                <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending}>
                  <Plus className="mr-1 h-4 w-4" />Record
                </Button>
              </div>
              <div className="space-y-1.5 sm:col-span-6">
                <Label className="text-xs">Notes (optional)</Label>
                <Input value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {staffId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Sign-offs for {currentStaff?.full_name}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Competency</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Granted</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staffHoldings.map((h) => {
                  const c = compById.get(h.competency_id);
                  const revoked = !!h.revoked_at;
                  const expired = h.expires_at
                    && h.expires_at < new Date().toISOString().slice(0, 10);
                  return (
                    <TableRow key={h.id} className={revoked ? "opacity-50" : ""}>
                      <TableCell>{c?.name ?? "—"}</TableCell>
                      <TableCell className="text-xs">{h.level ?? "—"}</TableCell>
                      <TableCell className="text-xs">{h.granted_at}</TableCell>
                      <TableCell className="text-xs">{h.expires_at ?? "—"}</TableCell>
                      <TableCell>
                        {revoked ? (
                          <Badge variant="outline">revoked {h.revoked_at}</Badge>
                        ) : expired ? (
                          <Badge variant="destructive">expired</Badge>
                        ) : (
                          <Badge variant="default"><Check className="mr-1 h-3 w-3" />active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {revoked ? (
                          <Button size="sm" variant="ghost" onClick={() => unrevoke.mutate(h.id)}>
                            Reinstate
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => revoke.mutate(h.id)}>
                            Revoke
                          </Button>
                        )}
                        <Button size="icon" variant="ghost"
                          onClick={() => { if (confirm("Delete this record entirely?")) remove.mutate(h.id); }}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {staffHoldings.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      No sign-offs recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
