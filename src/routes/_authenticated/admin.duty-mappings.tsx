import { PageHeader } from "@/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { PageLoading } from "@/components/loading";

export const Route = createFileRoute("/_authenticated/admin/duty-mappings")({
  head: () => ({ meta: [{ title: "Duty mappings — Salisbury Anaesthetics Rota" }] }),
  component: DutyMappingsPage,
});

const DUTY_TYPES = [
  "theatre",
  "consultant_in_charge",
  "obstetrics",
  "obstetrics_2nd",
  "icu_trainee",
  "icu_ct2_plus",
  "icu_consultant_oncall",
  "general_consultant_oncall",
  "registrar_oncall",
  "sho_oncall",
  "spa",
  "admin",
  "teaching",
  "non_clinical",
] as const;
type DutyType = (typeof DUTY_TYPES)[number];

const MATCH_TYPES = ["substring", "word", "regex"] as const;
type MatchType = (typeof MATCH_TYPES)[number];
const GRADES = ["any", "consultant", "sas", "trainee"] as const;
const SENIORITIES = ["any", "junior", "senior"] as const;

interface Mapping {
  id: string;
  duty_type: DutyType;
  pattern: string;
  match_type: MatchType;
  grade_filter: string | null;
  trainee_seniority_filter: string | null;
  priority: number;
  active: boolean;
  notes: string | null;
}

function DutyMappingsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["duty-type-mappings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("duty_type_mappings")
        .select("*")
        .order("priority", { ascending: true });
      if (error) throw error;
      return data as Mapping[];
    },
  });

  const [draft, setDraft] = useState({
    duty_type: "spa" as DutyType,
    pattern: "",
    match_type: "substring" as MatchType,
    grade_filter: "any" as (typeof GRADES)[number],
    trainee_seniority_filter: "any" as (typeof SENIORITIES)[number],
    priority: 100,
    notes: "",
  });

  const add = useMutation({
    mutationFn: async () => {
      if (!draft.pattern.trim()) throw new Error("Pattern required");
      const { error } = await supabase.from("duty_type_mappings").insert({
        duty_type: draft.duty_type,
        pattern: draft.pattern.trim(),
        match_type: draft.match_type,
        grade_filter: draft.grade_filter === "any" ? null : draft.grade_filter,
        trainee_seniority_filter:
          draft.trainee_seniority_filter === "any" ? null : draft.trainee_seniority_filter,
        priority: Number(draft.priority) || 100,
        notes: draft.notes.trim() || null,
        active: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Mapping added");
      setDraft((d) => ({ ...d, pattern: "", notes: "" }));
      qc.invalidateQueries({ queryKey: ["duty-type-mappings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (m: Partial<Mapping> & { id: string }) => {
      const { id, ...rest } = m;
      const { error } = await supabase.from("duty_type_mappings").update(rest).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["duty-type-mappings"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("duty_type_mappings").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["duty-type-mappings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Duty type mappings"
        description={
          <>
            Configure how CLWRota labels are classified into duty types. Mappings are evaluated in
            priority order (lower runs first); the first match wins, and unmatched rows default to{" "}
            <Badge variant="outline">theatre</Badge>. Changes take effect on the next sync.
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add mapping</CardTitle>
          <CardDescription>
            Pattern is matched (case-insensitive) against the concatenated consultant/role/specialty/theatre
            text from each CLWRota row. Use <em>word</em> for whole-word tokens like <code>SPA</code> or{" "}
            <code>CIC</code>, <em>substring</em> for general phrases, or <em>regex</em> for advanced rules.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-7">
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground">Pattern</label>
            <Input
              value={draft.pattern}
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
              placeholder="e.g. obstet, on-call"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Match</label>
            <Select
              value={draft.match_type}
              onValueChange={(v) => setDraft({ ...draft, match_type: v as MatchType })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MATCH_TYPES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">→ Duty type</label>
            <Select
              value={draft.duty_type}
              onValueChange={(v) => setDraft({ ...draft, duty_type: v as DutyType })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DUTY_TYPES.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Grade</label>
            <Select
              value={draft.grade_filter}
              onValueChange={(v) => setDraft({ ...draft, grade_filter: v as typeof GRADES[number] })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GRADES.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Trainee level</label>
            <Select
              value={draft.trainee_seniority_filter}
              onValueChange={(v) =>
                setDraft({ ...draft, trainee_seniority_filter: v as typeof SENIORITIES[number] })
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SENIORITIES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Priority</label>
            <Input
              type="number"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
            />
          </div>
          <div className="md:col-span-6">
            <label className="text-xs text-muted-foreground">Notes (optional)</label>
            <Input
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={() => add.mutate()} disabled={add.isPending} className="w-full">
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Current mappings {data ? <span className="text-muted-foreground">· {data.length}</span> : null}
          </CardTitle>
          <CardDescription>
            Lower priority runs first. Toggle <em>Active</em> to disable a rule without deleting it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <PageLoading />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Pri</TableHead>
                    <TableHead>Pattern</TableHead>
                    <TableHead>Match</TableHead>
                    <TableHead>Duty type</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead>Trainee</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="w-20">Active</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data ?? []).map((m) => (
                    <TableRow key={m.id} className={m.active ? "" : "opacity-50"}>
                      <TableCell>
                        <Input
                          type="number"
                          defaultValue={m.priority}
                          className="h-8 w-16"
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== m.priority) update.mutate({ id: m.id, priority: v });
                          }}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{m.pattern}</TableCell>
                      <TableCell><Badge variant="outline">{m.match_type}</Badge></TableCell>
                      <TableCell><Badge>{m.duty_type}</Badge></TableCell>
                      <TableCell className="text-xs">{m.grade_filter ?? "any"}</TableCell>
                      <TableCell className="text-xs">{m.trainee_seniority_filter ?? "any"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{m.notes ?? ""}</TableCell>
                      <TableCell>
                        <Switch
                          checked={m.active}
                          onCheckedChange={(v) => update.mutate({ id: m.id, active: v })}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm(`Delete mapping "${m.pattern}" → ${m.duty_type}?`)) {
                              del.mutate(m.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {(data ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                        No mappings — everything will be classified as theatre.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
