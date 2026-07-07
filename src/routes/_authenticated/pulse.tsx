import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/loading";
import { PulseSurveyDialog, type PulseCycle } from "@/components/wellbeing/PulseSurveyDialog";
import { formatDateWithWeekdayGB } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/pulse")({
  head: () => ({
    meta: [
      { title: "Wellbeing pulse — Salisbury Anaesthetics" },
      { name: "description", content: "Take the current 3-question wellbeing pulse." },
    ],
  }),
  component: PulsePage,
});

function PulsePage() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    enabled: !!user,
    queryKey: ["pulse-page", user?.id],
    queryFn: async () => {
      const [cycleRes, responseRes] = await Promise.all([
        supabase
          .from("pulse_survey_cycles")
          .select("*")
          .eq("active", true)
          .order("opens_at", { ascending: false })
          .limit(1),
        supabase
          .from("pulse_survey_responses")
          .select("cycle_id,score_1,score_2,score_3,created_at")
          .eq("staff_id", user!.id)
          .order("created_at", { ascending: false }),
      ]);
      if (cycleRes.error) throw cycleRes.error;
      if (responseRes.error) throw responseRes.error;
      return {
        cycle: (cycleRes.data ?? [])[0] as PulseCycle | undefined,
        history: responseRes.data ?? [],
      };
    },
  });

  if (isLoading) return <PageLoading />;

  const alreadyResponded =
    data?.cycle && data.history.some((r) => r.cycle_id === data.cycle!.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wellbeing pulse"
        description="A short, private check-in. Individual answers are visible only to admins; coordinators see aggregated department scores."
      />

      <Card>
        <CardContent className="space-y-3 p-6">
          {data?.cycle ? (
            <>
              <div className="text-sm text-muted-foreground">
                Cycle open until {formatDateWithWeekdayGB(data.cycle.closes_at!)}
              </div>
              <div className="space-y-1 text-sm">
                <div>1. {data.cycle.question_1}</div>
                <div>2. {data.cycle.question_2}</div>
                <div>3. {data.cycle.question_3}</div>
              </div>
              <Button onClick={() => setOpen(true)}>
                {alreadyResponded ? "Update my response" : "Take the pulse"}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No pulse survey is open at the moment. Check back next cycle.
            </p>
          )}
        </CardContent>
      </Card>

      {data && data.history.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-2 text-sm font-medium">My past responses</div>
            <div className="space-y-1 text-sm">
              {data.history.map((r, i) => (
                <div key={i} className="flex items-center justify-between border-b py-1 last:border-none">
                  <span className="text-muted-foreground">
                    {formatDateWithWeekdayGB(r.created_at.slice(0, 10))}
                  </span>
                  <span className="tabular-nums">
                    {r.score_1} · {r.score_2} · {r.score_3}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <PulseSurveyDialog
        open={open}
        onOpenChange={setOpen}
        onSaved={() => refetch()}
        cycle={data?.cycle ?? null}
      />
    </div>
  );
}
