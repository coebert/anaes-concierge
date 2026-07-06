import { PageHeader } from "@/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/duty-categories")({
  head: () => ({ meta: [{ title: "Duty categories — Salisbury Anaesthetics Rota" }] }),
  component: DutyCategoriesPage,
});

// Must mirror the duty_type enum and the CHECK constraint on
// duty_type_pool_rules.category.
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

const CATEGORIES = [
  {
    value: "clinical_list",
    label: "Clinical list",
    description:
      "Person is already covering a list this session (theatre, POAC, pain clinic, future activities). Removed from the headroom pool for that half-day.",
    badgeClass:
      "bg-emerald-500/15 text-success border-emerald-500/40",
  },
  {
    value: "excluded",
    label: "Excluded (all day)",
    description:
      "Person is unavailable for the whole day — ICU, obstetrics, on-call, teaching, admin, etc. Never counts toward headroom.",
    badgeClass:
      "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40",
  },
  {
    value: "flex",
    label: "Flexible cover (SPA)",
    description:
      "Not counted in baseline headroom, but counted in headroom-with-SPA as redeployable cover.",
    badgeClass:
      "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40",
  },
  {
    value: "ignored",
    label: "Ignored",
    description:
      "Does not affect the availability pool either way. Use for purely informational duty types.",
    badgeClass: "bg-muted text-muted-foreground border-border",
  },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

interface RuleRow {
  duty_type: DutyType;
  category: Category;
  notes: string | null;
}

function DutyCategoriesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["duty-type-pool-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("duty_type_pool_rules")
        .select("duty_type, category, notes");
      if (error) throw error;
      return (data ?? []) as RuleRow[];
    },
  });

  const byDuty = useMemo(() => {
    const m = new Map<DutyType, RuleRow>();
    for (const r of data ?? []) m.set(r.duty_type, r);
    return m;
  }, [data]);

  const [draft, setDraft] = useState<Record<DutyType, { category: Category; notes: string }>>(
    () =>
      Object.fromEntries(
        DUTY_TYPES.map((d) => [d, { category: "ignored" as Category, notes: "" }]),
      ) as Record<DutyType, { category: Category; notes: string }>,
  );

  // Sync draft with loaded data the first time it arrives (and any refetch).
  useMemo(() => {
    if (!data) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const d of DUTY_TYPES) {
        const row = byDuty.get(d);
        next[d] = {
          category: row?.category ?? "ignored",
          notes: row?.notes ?? "",
        };
      }
      return next;
    });
  }, [data, byDuty]);

  const save = useMutation({
    mutationFn: async (duty: DutyType) => {
      const row = draft[duty];
      const exists = byDuty.has(duty);
      if (exists) {
        const { error } = await supabase
          .from("duty_type_pool_rules")
          .update({
            category: row.category,
            notes: row.notes.trim() || null,
          })
          .eq("duty_type", duty);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("duty_type_pool_rules").insert({
          duty_type: duty,
          category: row.category,
          notes: row.notes.trim() || null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["duty-type-pool-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Duty categories"
        description="Decide how each duty type affects the robustness/availability pool."
      />
      <Card>
        <CardHeader>
          <CardTitle>Duty categories — headroom pool rules</CardTitle>
          <CardDescription>
            Decide how each duty type affects the robustness/availability pool. Set new
            clinical activities (POAC, pain clinic, future services) to{" "}
            <strong>Clinical list</strong> so anyone booked into them is excluded from
            headroom for that half-day. Changes take effect immediately for everyone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
            {CATEGORIES.map((c) => (
              <div key={c.value} className="rounded border p-2">
                <Badge variant="outline" className={c.badgeClass}>
                  {c.label}
                </Badge>
                <p className="mt-1 text-muted-foreground">{c.description}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Duty type</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DUTY_TYPES.map((d) => {
                const current = byDuty.get(d);
                const row = draft[d];
                const dirty =
                  (current?.category ?? "ignored") !== row.category ||
                  (current?.notes ?? "") !== row.notes;
                return (
                  <TableRow key={d}>
                    <TableCell className="font-mono text-xs">{d}</TableCell>
                    <TableCell>
                      <Select
                        value={row.category}
                        onValueChange={(v) =>
                          setDraft((prev) => ({
                            ...prev,
                            [d]: { ...prev[d], category: v as Category },
                          }))
                        }
                      >
                        <SelectTrigger className="w-[220px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={row.notes}
                        placeholder="Optional notes for coordinators"
                        maxLength={500}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [d]: { ...prev[d], notes: e.target.value },
                          }))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant={dirty ? "default" : "outline"}
                        disabled={!dirty || save.isPending}
                        onClick={() => save.mutate(d)}
                      >
                        Save
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
