import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/loading";
import {
  computeWellbeing,
  WELLBEING_BAND_LABEL,
  WELLBEING_BAND_TONE,
} from "@/features/wellbeing/wellbeing-score";
import { computeBradfordFactor } from "@/lib/bradford-factor";
import { PulseSurveyDialog, type PulseCycle } from "@/components/wellbeing/PulseSurveyDialog";
import { RecognitionDialog } from "@/components/wellbeing/RecognitionDialog";
import { HeartHandshake, MessageCircleHeart, Sparkles } from "lucide-react";
import { formatDateWithWeekdayGB } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/wellbeing")({
  head: () => ({
    meta: [
      { title: "My wellbeing — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Personal wellbeing snapshot based on rota load, leave, sickness and recognition — plus the current pulse survey.",
      },
    ],
  }),
  component: WellbeingPage,
});

function WellbeingPage() {
  const { user } = useAuth();
  const [pulseOpen, setPulseOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    enabled: !!user,
    queryKey: ["my-wellbeing", user?.id],
    queryFn: async () => {
      const [assignRes, changesRes, leaveRes, exRes, cycleRes, responseRes, recRes] =
        await Promise.all([
          supabase
            .from("rota_assignments")
            .select("staff_id,session_date,session")
            .eq("staff_id", user!.id)
            .gte("session_date", isoDaysAgo(365))
            .range(0, 9999),
          supabase
            .from("rota_change_log")
            .select("staff_id,session_date,hours_before_session")
            .eq("staff_id", user!.id)
            .range(0, 4999),
          supabase
            .from("leave_requests")
            .select("staff_id,type,status,start_date,end_date,half_day_start,half_day_end")
            .eq("staff_id", user!.id)
            .range(0, 4999),
          supabase
            .from("exception_reports")
            .select("trainee_id,event_date")
            .eq("trainee_id", user!.id)
            .range(0, 999),
          supabase
            .from("pulse_survey_cycles")
            .select("*")
            .eq("active", true)
            .order("opens_at", { ascending: false })
            .limit(1),
          supabase
            .from("pulse_survey_responses")
            .select("cycle_id")
            .eq("staff_id", user!.id),
          supabase
            .rpc("get_recognition_decrypted", { p_staff_id: user!.id, p_limit: 20 }),
        ]);

      if (assignRes.error) throw assignRes.error;
      if (changesRes.error) throw changesRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (exRes.error) throw exRes.error;

      return {
        assignments: assignRes.data ?? [],
        changes: changesRes.data ?? [],
        leave: leaveRes.data ?? [],
        exceptions: exRes.data ?? [],
        openCycle: (cycleRes.data ?? [])[0] as PulseCycle | undefined,
        respondedCycleIds: new Set((responseRes.data ?? []).map((r) => r.cycle_id)),
        recognition: (recRes.data ?? []) as Array<{
          id: string;
          category: string;
          message: string | null;
          created_at: string;
          is_public: boolean;
        }>,
      };
    },
  });

  const wellbeing = useMemo(() => {
    if (!data || !user) return null;
    const sickSpells = data.leave.filter(
      (l) => l.type === "sick" && l.status === "approved",
    );
    const bradford = computeBradfordFactor(
      sickSpells.map((s) => ({
        start_date: s.start_date,
        end_date: s.end_date,
        half_day_start: s.half_day_start,
        half_day_end: s.half_day_end,
      })),
    );
    return computeWellbeing({
      staffId: user.id,
      assignments: data.assignments,
      changes: data.changes,
      leave: data.leave,
      exceptions: data.exceptions,
      bradfordScore: bradford.score,
    });
  }, [data, user]);

  if (isLoading || !wellbeing) return <PageLoading />;

  const alreadyResponded =
    data?.openCycle && data.respondedCycleIds.has(data.openCycle.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My wellbeing"
        description="A private snapshot combining your rota load, unsocial hours, short-notice changes, leave and sickness signals. Only you and admins can see this page."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-base">
              <span>Rolling 90-day wellbeing score</span>
              <Badge className={WELLBEING_BAND_TONE[wellbeing.band]}>
                {WELLBEING_BAND_LABEL[wellbeing.band]}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-5xl font-semibold tabular-nums">
              {wellbeing.score}
              <span className="ml-1 text-lg text-muted-foreground">/ 100</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Window: {formatDateWithWeekdayGB(wellbeing.windowStart)} →{" "}
              {formatDateWithWeekdayGB(wellbeing.windowEnd)}
            </div>
            <div className="space-y-2 pt-2">
              {wellbeing.drivers.map((d) => (
                <div key={d.key} className="flex items-center gap-2 text-sm">
                  <div className="w-40 shrink-0 text-muted-foreground">{d.key}</div>
                  <div className="h-2 flex-1 rounded bg-muted">
                    <div
                      className="h-2 rounded bg-primary/60"
                      style={{ width: `${Math.round(d.normalised * 100)}%` }}
                    />
                  </div>
                  <div className="w-56 text-right text-xs">{d.label}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageCircleHeart className="h-4 w-4" /> Pulse survey
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data?.openCycle ? (
                alreadyResponded ? (
                  <p className="text-sm text-muted-foreground">
                    Thanks — your response for the current cycle is saved. Reopen
                    the survey to update it.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    A pulse survey is open until{" "}
                    {formatDateWithWeekdayGB(data.openCycle.closes_at)}.
                  </p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  No pulse survey open at the moment.
                </p>
              )}
              <Button
                className="mt-3 w-full"
                variant={alreadyResponded ? "outline" : "default"}
                onClick={() => setPulseOpen(true)}
                disabled={!data?.openCycle}
              >
                {alreadyResponded ? "Update my response" : "Take the pulse"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <HeartHandshake className="h-4 w-4" /> Recognition received
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data && data.recognition.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No kudos yet — but it only takes a moment to{" "}
              <a href="/recognition" className="underline">send one to a colleague</a>.
            </p>
          ) : (
            <div className="space-y-2">
              {data?.recognition.map((r) => (
                <div key={r.id} className="rounded-md border p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge variant="secondary" className="capitalize">
                      {r.category.replace("_", " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDateWithWeekdayGB(r.created_at.slice(0, 10))}
                    </span>
                    {!r.is_public && (
                      <Badge variant="outline" className="text-xs">Private</Badge>
                    )}
                  </div>
                  <div>{r.message ?? <em className="text-muted-foreground">Message not available.</em>}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button variant="outline" asChild>
              <a href="/recognition">
                <Sparkles className="mr-2 h-4 w-4" /> Send a kudos
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <PulseSurveyDialog
        open={pulseOpen}
        onOpenChange={setPulseOpen}
        onSaved={() => refetch()}
        cycle={data?.openCycle ?? null}
      />
    </div>
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
