import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/loading";
import { toast } from "sonner";
import { formatDateWithWeekdayGB } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/pulse")({
  head: () => ({
    meta: [
      { title: "Pulse survey admin — Salisbury Anaesthetics" },
      { name: "description", content: "Manage wellbeing pulse cycles and review aggregated results." },
    ],
  }),
  component: AdminPulsePage,
});

interface Cycle {
  id: string;
  opens_at: string;
  closes_at: string;
  question_1: string;
  question_2: string;
  question_3: string;
  active: boolean;
}

interface Aggregate {
  cycle_id: string;
  opens_at: string;
  closes_at: string;
  response_count: number;
  avg_score_1: number | null;
  avg_score_2: number | null;
  avg_score_3: number | null;
}

function AdminPulsePage() {
  const { hasRole, loading, user } = useAuth();
  const [q1, setQ1] = useState("I feel supported by my team.");
  const [q2, setQ2] = useState("My workload is sustainable this month.");
  const [q3, setQ3] = useState("I would recommend this department to a friend.");
  const [opensAt, setOpensAt] = useState(new Date().toISOString().slice(0, 10));
  const [closesAt, setClosesAt] = useState(
    new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-pulse-cycles"],
    queryFn: async () => {
      const [cyclesRes, aggRes] = await Promise.all([
        supabase
          .from("pulse_survey_cycles")
          .select("*")
          .order("opens_at", { ascending: false }),
        supabase.rpc("get_pulse_aggregate"),
      ]);
      if (cyclesRes.error) throw cyclesRes.error;
      if (aggRes.error) throw aggRes.error;
      return {
        cycles: (cyclesRes.data ?? []) as Cycle[],
        aggregates: (aggRes.data ?? []) as Aggregate[],
      };
    },
  });

  const create = async () => {
    setSaving(true);
    const { error } = await supabase.from("pulse_survey_cycles").insert({
      opens_at: opensAt,
      closes_at: closesAt,
      question_1: q1,
      question_2: q2,
      question_3: q3,
      created_by: user?.id ?? null,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("New pulse cycle opened");
    refetch();
  };

  const toggleActive = async (c: Cycle) => {
    const { error } = await supabase
      .from("pulse_survey_cycles")
      .update({ active: !c.active })
      .eq("id", c.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    refetch();
  };

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pulse surveys"
        description="Open a new 3-question wellbeing pulse and review aggregated results across cycles."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New pulse cycle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Opens</Label>
              <Input type="date" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
            </div>
            <div>
              <Label>Closes</Label>
              <Input type="date" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Question 1</Label>
            <Textarea rows={2} value={q1} onChange={(e) => setQ1(e.target.value)} />
          </div>
          <div>
            <Label>Question 2</Label>
            <Textarea rows={2} value={q2} onChange={(e) => setQ2(e.target.value)} />
          </div>
          <div>
            <Label>Question 3</Label>
            <Textarea rows={2} value={q3} onChange={(e) => setQ3(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button onClick={create} disabled={saving}>
              {saving ? "Opening…" : "Open new cycle"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cycles & aggregate results</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <PageLoading />
          ) : data && data.cycles.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No cycles yet.
            </p>
          ) : (
            <div className="space-y-3">
              {data?.cycles.map((c) => {
                const agg = data.aggregates.find((a) => a.cycle_id === c.id);
                return (
                  <div key={c.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2 pb-2">
                      <Badge variant={c.active ? "default" : "outline"}>
                        {c.active ? "Active" : "Closed"}
                      </Badge>
                      <span className="text-sm">
                        {formatDateWithWeekdayGB(c.opens_at)} →{" "}
                        {formatDateWithWeekdayGB(c.closes_at)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {agg?.response_count ?? 0} responses
                      </span>
                      <div className="ml-auto flex items-center gap-2">
                        <Switch checked={c.active} onCheckedChange={() => toggleActive(c)} />
                        <span className="text-xs">Active</span>
                      </div>
                    </div>
                    <div className="grid gap-2 text-sm sm:grid-cols-3">
                      <ScoreLine label={c.question_1} value={agg?.avg_score_1} />
                      <ScoreLine label={c.question_2} value={agg?.avg_score_2} />
                      <ScoreLine label={c.question_3} value={agg?.avg_score_3} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ScoreLine({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="rounded border p-2">
      <div className="text-xs text-muted-foreground line-clamp-2">{label}</div>
      <div className="text-lg font-medium tabular-nums">
        {value == null ? "—" : Number(value).toFixed(2)}
        <span className="ml-1 text-xs text-muted-foreground">/ 5</span>
      </div>
    </div>
  );
}
