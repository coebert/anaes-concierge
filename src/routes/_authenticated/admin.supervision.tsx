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
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { compareBySurname } from "@/lib/name-sort";
import { formatDateGB } from "@/lib/utils";
import {
  summariseTraineeReadiness,
  readinessStatusLabel,
  readinessStatusTone,
  type ArcpProgress,
  type ArcpRequirement,
  type ReadinessStatus,
} from "@/features/supervision/arcp";

export const Route = createFileRoute("/_authenticated/admin/supervision")({
  head: () => ({
    meta: [{ title: "Educational supervision — Salisbury Anaesthetics Rota" }],
  }),
  component: SupervisionGuard,
  errorComponent: ({ error }) => (
    <Card><CardContent className="p-6 text-sm text-destructive">
      {(error as Error).message}
    </CardContent></Card>
  ),
  notFoundComponent: () => (
    <Card><CardContent className="p-6 text-sm text-muted-foreground">
      Not found.
    </CardContent></Card>
  ),
});

function SupervisionGuard() {
  const { hasRole, loading } = useAuth();
  if (loading) return null;
  if (!hasRole("admin") && !hasRole("rota_coordinator")) {
    return (
      <Card><CardContent className="p-6 text-sm text-muted-foreground">
        Only coordinators or administrators can manage supervision.
      </CardContent></Card>
    );
  }
  return <SupervisionPage />;
}

interface Profile { id: string; full_name: string; grade: string | null; training_level: string | null; active: boolean }
interface Assignment {
  id: string;
  trainee_id: string;
  supervisor_id: string;
  valid_from: string;
  valid_to: string | null;
  notes: string | null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function SupervisionPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Educational supervision"
        description="Manage supervisor pairings and track ARCP readiness for trainees."
      />
      <Tabs defaultValue="readiness">
        <TabsList>
          <TabsTrigger value="readiness">ARCP readiness</TabsTrigger>
          <TabsTrigger value="pairings">Supervisor pairings</TabsTrigger>
          <TabsTrigger value="requirements">Requirements catalogue</TabsTrigger>
        </TabsList>
        <TabsContent value="readiness"><ReadinessTab /></TabsContent>
        <TabsContent value="pairings"><PairingsTab /></TabsContent>
        <TabsContent value="requirements"><RequirementsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ------------------------------------------------------------------
// Readiness dashboard
// ------------------------------------------------------------------
function ReadinessTab() {
  const [selectedTrainee, setSelectedTrainee] = useState<string | null>(null);
  const today = todayISO();

  const { data: trainees } = useQuery({
    queryKey: ["profiles-trainees"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade,training_level,active")
        .eq("grade", "trainee")
        .eq("active", true);
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });

  const { data: requirements } = useQuery({
    queryKey: ["arcp-requirements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("arcp_requirements")
        .select("id,training_level,code,label,category,target_value,unit,sort_order,active")
        .eq("active", true);
      if (error) throw error;
      return (data ?? []) as ArcpRequirement[];
    },
  });

  const { data: progress } = useQuery({
    queryKey: ["arcp-progress"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("arcp_progress")
        .select("id,trainee_id,requirement_id,current_value,arcp_date,notes");
      if (error) throw error;
      return (data ?? []) as ArcpProgress[];
    },
  });

  const summaries = useMemo(() => {
    if (!trainees || !requirements) return [];
    const progByTrainee = new Map<string, ArcpProgress[]>();
    for (const p of progress ?? []) {
      const arr = progByTrainee.get(p.trainee_id) ?? [];
      arr.push(p);
      progByTrainee.set(p.trainee_id, arr);
    }
    return trainees.map((t) => ({
      trainee: t,
      summary: summariseTraineeReadiness({
        traineeId: t.id,
        trainingLevel: t.training_level,
        requirements,
        progress: progByTrainee.get(t.id) ?? [],
        today,
      }),
    })).sort((a, b) => {
      const rank = (s: ReadinessStatus) =>
        s === "behind" ? 0 : s === "at_risk" ? 1 : s === "on_track" ? 2 : s === "complete" ? 3 : 4;
      const rd = rank(a.summary.worstStatus) - rank(b.summary.worstStatus);
      if (rd !== 0) return rd;
      return compareBySurname(a.trainee.full_name, b.trainee.full_name);
    });
  }, [trainees, requirements, progress, today]);

  const selected = summaries.find((s) => s.trainee.id === selectedTrainee) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Card>
        <CardHeader><CardTitle className="text-base">Trainees</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trainee</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summaries.map(({ trainee, summary }) => (
                <TableRow
                  key={trainee.id}
                  className="cursor-pointer hover:bg-muted/40"
                  data-selected={selectedTrainee === trainee.id}
                  onClick={() => setSelectedTrainee(trainee.id)}
                >
                  <TableCell className="font-medium">{trainee.full_name}</TableCell>
                  <TableCell>{trainee.training_level ?? "—"}</TableCell>
                  <TableCell className="w-40">
                    <Progress value={summary.percentComplete} />
                    <span className="text-[11px] text-muted-foreground">
                      {summary.percentComplete}%
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={summary.worstStatus} />
                    {summary.behindCount > 0 && (
                      <span className="ml-2 text-[11px] text-destructive">
                        {summary.behindCount} behind
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {summaries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">
                    No active trainees.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selected ? (
        <TraineeDetail
          trainee={selected.trainee}
          summary={selected.summary}
        />
      ) : (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          Select a trainee to review their ARCP readiness in detail.
        </CardContent></Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ReadinessStatus }) {
  const tone = readinessStatusTone(status);
  const cls =
    tone === "success" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" :
    tone === "warning" ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" :
    tone === "danger" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200" :
    "bg-muted text-muted-foreground";
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
    {readinessStatusLabel(status)}
  </span>;
}

function TraineeDetail({
  trainee, summary,
}: { trainee: Profile; summary: ReturnType<typeof summariseTraineeReadiness> }) {
  const qc = useQueryClient();

  const { data: currentSupervisor } = useQuery({
    queryKey: ["supervisor-for", trainee.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("educational_supervisor_assignments")
        .select("id,supervisor_id,valid_from,valid_to")
        .eq("trainee_id", trainee.id)
        .lte("valid_from", todayISO())
        .order("valid_from", { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0] ?? null;
    },
  });

  const { data: supervisorName } = useQuery({
    queryKey: ["profile-name", currentSupervisor?.supervisor_id],
    enabled: !!currentSupervisor?.supervisor_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("full_name")
        .eq("id", currentSupervisor!.supervisor_id).maybeSingle();
      if (error) throw error;
      return data?.full_name ?? null;
    },
  });

  const upsertProgress = useMutation({
    mutationFn: async (vars: {
      requirement_id: string;
      current_value: number;
      arcp_date: string | null;
    }) => {
      const { error } = await supabase.from("arcp_progress").upsert({
        trainee_id: trainee.id,
        requirement_id: vars.requirement_id,
        current_value: vars.current_value,
        arcp_date: vars.arcp_date,
        last_reviewed_at: new Date().toISOString(),
      }, { onConflict: "trainee_id,requirement_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["arcp-progress"] });
      toast.success("Progress updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{trainee.full_name}</CardTitle>
        <div className="text-xs text-muted-foreground space-y-0.5">
          <div>Level: {trainee.training_level ?? "—"}</div>
          <div>
            Educational supervisor: {supervisorName ?? "Not assigned"}
            {currentSupervisor?.valid_to && (
              <> (until {formatDateGB(currentSupervisor.valid_to)})</>
            )}
          </div>
          <div>
            Overall: <StatusBadge status={summary.worstStatus} /> · {summary.percentComplete}% complete
            {summary.nextArcpDate && <> · ARCP {formatDateGB(summary.nextArcpDate)}</>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {summary.items.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No ARCP requirements defined for training level "{trainee.training_level ?? "—"}".
            Add them under the Requirements catalogue tab.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Requirement</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>ARCP</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.items.map((item) => (
                <RequirementRow
                  key={item.requirement.id}
                  item={item}
                  onSave={(current, arcpDate) => upsertProgress.mutate({
                    requirement_id: item.requirement.id,
                    current_value: current,
                    arcp_date: arcpDate || null,
                  })}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function RequirementRow({
  item, onSave,
}: {
  item: ReturnType<typeof summariseTraineeReadiness>["items"][number];
  onSave: (current: number, arcpDate: string) => void;
}) {
  const [current, setCurrent] = useState<string>(String(item.current));
  const [arcpDate, setArcpDate] = useState<string>(item.progress?.arcp_date ?? "");
  const dirty = Number(current) !== item.current ||
    (arcpDate || "") !== (item.progress?.arcp_date ?? "");
  return (
    <TableRow>
      <TableCell>
        <div className="text-sm font-medium">{item.requirement.label}</div>
        <div className="text-[11px] text-muted-foreground">
          Target {item.target} {item.requirement.unit}
        </div>
      </TableCell>
      <TableCell>
        <Input
          type="number" min={0} step="1" value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="h-7 w-20 text-xs"
        />
      </TableCell>
      <TableCell>
        <Input
          type="date" value={arcpDate}
          onChange={(e) => setArcpDate(e.target.value)}
          className="h-7 w-36 text-xs"
        />
      </TableCell>
      <TableCell>
        <StatusBadge status={item.status} />
        {item.monthsToArcp !== null && (
          <div className="text-[10px] text-muted-foreground">
            {item.monthsToArcp > 0
              ? `${item.monthsToArcp.toFixed(1)} mo left`
              : `${(-item.monthsToArcp).toFixed(1)} mo past`}
          </div>
        )}
      </TableCell>
      <TableCell>
        <Button
          size="sm" variant={dirty ? "default" : "ghost"}
          disabled={!dirty}
          onClick={() => onSave(Number(current) || 0, arcpDate)}
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

// ------------------------------------------------------------------
// Supervisor pairings
// ------------------------------------------------------------------
function PairingsTab() {
  const qc = useQueryClient();
  const [traineeId, setTraineeId] = useState("");
  const [supervisorId, setSupervisorId] = useState("");
  const [validFrom, setValidFrom] = useState(todayISO());
  const [validTo, setValidTo] = useState("");

  const { data: profiles } = useQuery({
    queryKey: ["profiles-consultants-and-trainees"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade,training_level,active")
        .eq("active", true);
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });

  const { data: pairings } = useQuery({
    queryKey: ["supervisor-assignments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("educational_supervisor_assignments")
        .select("id,trainee_id,supervisor_id,valid_from,valid_to,notes")
        .order("valid_from", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Assignment[];
    },
  });

  const byId = useMemo(
    () => new Map((profiles ?? []).map((p) => [p.id, p])),
    [profiles],
  );

  const create = useMutation({
    mutationFn: async () => {
      if (!traineeId || !supervisorId || !validFrom) {
        throw new Error("Trainee, supervisor and valid-from date are required.");
      }
      const { error } = await supabase.from("educational_supervisor_assignments").insert({
        trainee_id: traineeId,
        supervisor_id: supervisorId,
        valid_from: validFrom,
        valid_to: validTo || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["supervisor-assignments"] });
      qc.invalidateQueries({ queryKey: ["supervisor-for"] });
      setTraineeId(""); setSupervisorId(""); setValidTo("");
      toast.success("Pairing added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("educational_supervisor_assignments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["supervisor-assignments"] });
      qc.invalidateQueries({ queryKey: ["supervisor-for"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const trainees = (profiles ?? []).filter((p) => p.grade === "trainee")
    .sort((a, b) => compareBySurname(a.full_name, b.full_name));
  const supervisors = (profiles ?? []).filter((p) => p.grade === "consultant" || p.grade === "sas")
    .sort((a, b) => compareBySurname(a.full_name, b.full_name));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">New pairing</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-5">
          <div className="space-y-1.5">
            <Label className="text-xs">Trainee</Label>
            <Select value={traineeId} onValueChange={setTraineeId}>
              <SelectTrigger><SelectValue placeholder="Pick trainee" /></SelectTrigger>
              <SelectContent>
                {trainees.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.full_name} {t.training_level ? `(${t.training_level})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Supervisor</Label>
            <Select value={supervisorId} onValueChange={setSupervisorId}>
              <SelectTrigger><SelectValue placeholder="Pick supervisor" /></SelectTrigger>
              <SelectContent>
                {supervisors.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Valid from</Label>
            <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Valid to (optional)</Label>
            <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">All pairings</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trainee</TableHead>
                <TableHead>Supervisor</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pairings ?? []).map((a) => {
                const active = a.valid_from <= todayISO() &&
                  (!a.valid_to || a.valid_to >= todayISO());
                return (
                  <TableRow key={a.id}>
                    <TableCell>{byId.get(a.trainee_id)?.full_name ?? "—"}</TableCell>
                    <TableCell>
                      {byId.get(a.supervisor_id)?.full_name ?? "—"}
                      {active && <Badge variant="secondary" className="ml-2 text-[10px]">current</Badge>}
                    </TableCell>
                    <TableCell>{formatDateGB(a.valid_from)}</TableCell>
                    <TableCell>{a.valid_to ? formatDateGB(a.valid_to) : "—"}</TableCell>
                    <TableCell>
                      <Button size="icon" variant="ghost" onClick={() => remove.mutate(a.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(!pairings || pairings.length === 0) && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                    No supervisor pairings yet.
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

// ------------------------------------------------------------------
// Requirements catalogue
// ------------------------------------------------------------------
function RequirementsTab() {
  const qc = useQueryClient();
  const [level, setLevel] = useState("CT1");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("1");

  const { data: requirements } = useQuery({
    queryKey: ["arcp-requirements-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("arcp_requirements")
        .select("id,training_level,code,label,category,target_value,unit,sort_order,active")
        .order("training_level").order("sort_order");
      if (error) throw error;
      return (data ?? []) as ArcpRequirement[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!code || !label) throw new Error("Code and label required.");
      const { error } = await supabase.from("arcp_requirements").insert({
        training_level: level, code, label,
        target_value: Number(target) || 1,
        category: "other", unit: "count", sort_order: 100, active: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["arcp-requirements-all"] });
      qc.invalidateQueries({ queryKey: ["arcp-requirements"] });
      setCode(""); setLabel(""); setTarget("1");
      toast.success("Requirement added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("arcp_requirements").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["arcp-requirements-all"] });
      qc.invalidateQueries({ queryKey: ["arcp-requirements"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Add requirement</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-5">
          <div className="space-y-1.5">
            <Label className="text-xs">Training level</Label>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["CT1","CT2","CT3","ST3","ST4","ST5","ST6","ST7"].map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Code</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. wbas" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Target</Label>
            <Input type="number" min={0} value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
          <div className="sm:col-span-5">
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">All requirements</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Level</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(requirements ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.training_level}</TableCell>
                  <TableCell className="font-mono text-[11px]">{r.code}</TableCell>
                  <TableCell>{r.label}</TableCell>
                  <TableCell>{r.target_value} {r.unit}</TableCell>
                  <TableCell>{r.category}</TableCell>
                  <TableCell>
                    <Button size="icon" variant="ghost" onClick={() => remove.mutate(r.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(!requirements || requirements.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">
                    No requirements defined.
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
