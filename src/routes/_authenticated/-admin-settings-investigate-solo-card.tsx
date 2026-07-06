import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { investigateAndFixTraineeSolo } from "@/features/clwrota/clwrota.functions";
import { Stat } from "./-admin-settings-stat";

export function InvestigateSoloCard() {
  const qc = useQueryClient();
  const investigate = useServerFn(investigateAndFixTraineeSolo);
  const [result, setResult] = useState<null | Awaited<
    ReturnType<typeof investigateAndFixTraineeSolo>
  >>(null);

  const previewMut = useMutation({
    mutationFn: () => investigate({ data: { apply: false } }),
    onSuccess: (res) => setResult(res),
    onError: (e: Error) => toast.error(e.message),
  });
  const applyMut = useMutation({
    mutationFn: () => investigate({ data: { apply: true } }),
    onSuccess: (res) => {
      setResult(res);
      toast.success(
        `Corrected ${res.applied} list(s)` +
          (res.sync_run_id ? ` · run ${res.sync_run_id.slice(0, 8)}` : ""),
      );
      void qc.invalidateQueries({ queryKey: ["reclassification-runs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const isPending = previewMut.isPending || applyMut.isPending;
  const autoCount = result?.counts.consultant_or_sas_on_session ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Investigate suspicious solo lists</CardTitle>
        <CardDescription>
          Re-evaluate every trainee "solo" rota row in the last 60 / next 60 days. Rows
          where a consultant or SAS doctor is on the same theatre session are corrected
          automatically; review-only categories (unmatched labels, off-day placeholders)
          are surfaced for manual cleanup. Locally-modified rows are never touched.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => previewMut.mutate()}
          >
            {previewMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Preview findings
          </Button>
          <Button
            size="sm"
            disabled={isPending || (result !== null && autoCount === 0)}
            onClick={() => {
              if (
                window.confirm(
                  `Auto-correct ${autoCount || "any"} trainee "solo" list(s) where a consultant/SAS is on the same theatre session?`,
                )
              ) {
                applyMut.mutate();
              }
            }}
          >
            {applyMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Investigate &amp; fix now
          </Button>
        </div>

        {result ? (
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Stat
                label="Auto-correctable (consultant/SAS on session)"
                value={result.counts.consultant_or_sas_on_session}
                tone={result.counts.consultant_or_sas_on_session > 0 ? "info" : undefined}
              />
              <Stat
                label="Review: unmatched theatre row"
                value={result.counts.unmatched_theatre_solo}
                tone={result.counts.unmatched_theatre_solo > 0 ? "danger" : undefined}
              />
              <Stat
                label="Review: non-training label"
                value={result.counts.non_training_label}
                tone={result.counts.non_training_label > 0 ? "danger" : undefined}
              />
            </div>
            {result.applied > 0 ? (
              <p className="text-xs text-emerald-600">
                {result.applied} list(s) reclassified solo → supervised in run{" "}
                {result.sync_run_id?.slice(0, 8)}.
              </p>
            ) : null}
            {result.sample.length > 0 ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Sample findings ({result.sample.length})
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {result.sample.map((s) => (
                    <li key={s.assignment_id}>
                      <Badge variant="outline" className="mr-1">
                        {s.category}
                      </Badge>
                      {s.staff_name} · {s.session_date ?? "—"} · {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
