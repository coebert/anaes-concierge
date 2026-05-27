import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/rules")({
  component: RulesPage,
});

type Rules = {
  sessions_per_pa: number;
  default_total_pas: number;
  default_dcc_pas: number;
  default_spa_pas: number;
  max_sessions_per_week: number;
  max_consecutive_days: number;
  min_rest_hours: number;
  oncall_pa_credit: number;
  weekend_pa_credit: number;
  ltft_round_to: number;
  honour_fixed_sessions: boolean;
  allow_back_to_back_oncall: boolean;
  post_nights_off_days: number;
  trainee_at_risk_pct: number;
  trainee_behind_pct: number;
  notes: string;
};

const DEFAULTS: Rules = {
  sessions_per_pa: 1,
  default_total_pas: 10,
  default_dcc_pas: 7.5,
  default_spa_pas: 2.5,
  max_sessions_per_week: 10,
  max_consecutive_days: 7,
  min_rest_hours: 11,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
  ltft_round_to: 0.5,
  honour_fixed_sessions: true,
  allow_back_to_back_oncall: false,
  post_nights_off_days: 2,
  trainee_at_risk_pct: 50,
  trainee_behind_pct: 75,
  notes: "",
};

function RulesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["rota-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_rules")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [form, setForm] = useState<Rules>(DEFAULTS);

  useEffect(() => {
    if (data) {
      setForm({
        sessions_per_pa: Number(data.sessions_per_pa),
        default_total_pas: Number(data.default_total_pas),
        default_dcc_pas: Number(data.default_dcc_pas),
        default_spa_pas: Number(data.default_spa_pas),
        max_sessions_per_week: Number(data.max_sessions_per_week),
        max_consecutive_days: Number(data.max_consecutive_days),
        min_rest_hours: Number(data.min_rest_hours),
        oncall_pa_credit: Number(data.oncall_pa_credit),
        weekend_pa_credit: Number(data.weekend_pa_credit),
        ltft_round_to: Number(data.ltft_round_to),
        honour_fixed_sessions: data.honour_fixed_sessions,
        allow_back_to_back_oncall: data.allow_back_to_back_oncall,
        post_nights_off_days: Number(data.post_nights_off_days),
        trainee_at_risk_pct: Number((data as { trainee_at_risk_pct?: number }).trainee_at_risk_pct ?? 50),
        trainee_behind_pct: Number((data as { trainee_behind_pct?: number }).trainee_behind_pct ?? 75),
        notes: data.notes ?? "",
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("rota_rules")
        .update({ ...form, notes: form.notes || null })
        .eq("id", 1);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rules saved");
      qc.invalidateQueries({ queryKey: ["rota-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const num = (k: keyof Rules, step = "0.5") => (
    <Input
      type="number"
      step={step}
      value={form[k] as number}
      onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
    />
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Working-pattern rules</h1>
        <p className="text-sm text-muted-foreground">
          Global defaults and constraints used by rota calculations and job-plan validation.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PA & session defaults</CardTitle>
          <CardDescription>Baseline values applied when creating new job plans.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Field label="Sessions per PA">{num("sessions_per_pa", "0.25")}</Field>
          <Field label="Default total PAs / week">{num("default_total_pas")}</Field>
          <Field label="Max sessions / week">{num("max_sessions_per_week")}</Field>
          <Field label="Default DCC PAs">{num("default_dcc_pas")}</Field>
          <Field label="Default SPA PAs">{num("default_spa_pas")}</Field>
          <Field label="LTFT round to">{num("ltft_round_to", "0.05")}</Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Safety constraints</CardTitle>
          <CardDescription>Hard limits enforced when generating rotas.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Field label="Max consecutive days">{num("max_consecutive_days", "1")}</Field>
          <Field label="Min rest hours">{num("min_rest_hours", "1")}</Field>
          <Field label="Post-nights off days">{num("post_nights_off_days", "1")}</Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-call credit</CardTitle>
          <CardDescription>PA credit awarded for on-call and weekend duties.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="On-call PA credit">{num("oncall_pa_credit", "0.25")}</Field>
          <Field label="Weekend PA credit">{num("weekend_pa_credit", "0.25")}</Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Behaviour</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            label="Honour fixed sessions"
            description="Lock in each staff member's fixed weekly sessions before solving."
            checked={form.honour_fixed_sessions}
            onChange={(v) => setForm({ ...form, honour_fixed_sessions: v })}
          />
          <ToggleRow
            label="Allow back-to-back on-call"
            description="Permit a staff member to cover consecutive on-call shifts."
            checked={form.allow_back_to_back_oncall}
            onChange={(v) => setForm({ ...form, allow_back_to_back_oncall: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            rows={3}
            placeholder="Local exceptions, derogations, BMA caveats…"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save rules"}
        </Button>
      </div>

      <CustomRulesCard />
    </div>
  );
}

function CustomRulesCard() {
  const qc = useQueryClient();
  const { data: rules } = useQuery({
    queryKey: ["custom-rota-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_rota_rules")
        .select("id,scope,staff_id,grade,summary,rule_text,active,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const staffIds = Array.from(
    new Set((rules ?? []).filter((r) => r.staff_id).map((r) => r.staff_id as string)),
  );
  const { data: staff } = useQuery({
    queryKey: ["custom-rule-staff-names", staffIds.sort().join(",")],
    enabled: staffIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", staffIds);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.full_name]));
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("custom_rota_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rule removed");
      qc.invalidateQueries({ queryKey: ["custom-rota-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from("custom_rota_rules")
        .update({ active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-rota-rules"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom rules taught to the AI assistant</CardTitle>
        <CardDescription>
          Plain-English working-pattern rules the AI remembers and factors into rota writing.
          Create new rules by chatting with the assistant (e.g. "Dr Smith always has the morning
          off after an overnight on-call").
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {(!rules || rules.length === 0) && (
          <p className="text-sm text-muted-foreground">
            No custom rules yet. Open the assistant and tell it about a working pattern to
            remember.
          </p>
        )}
        {rules?.map((r) => (
          <div
            key={r.id}
            className="flex items-start justify-between gap-3 rounded-md border p-3"
          >
            <div className="space-y-1">
              <div className="text-sm font-medium flex items-center gap-2">
                {r.summary}
                {!r.active && (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    inactive
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {r.scope === "staff"
                  ? `Staff: ${staff?.get(r.staff_id ?? "") ?? r.staff_id}`
                  : r.scope === "grade"
                    ? `Grade: ${r.grade}`
                    : "Department-wide"}
              </div>
              <div className="text-xs">{r.rule_text}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                checked={r.active}
                onCheckedChange={(v) => toggle.mutate({ id: r.id, active: v })}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => del.mutate(r.id)}
                disabled={del.isPending}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function ToggleRow({
  label, description, checked, onChange,
}: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
