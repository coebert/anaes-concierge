import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import {
  listReclassificationRuns,
  undoReclassificationRun,
} from "@/features/clwrota/clwrota.functions";
import { formatDateGB } from "@/lib/utils";

export function ReclassificationUndoCard() {
  const qc = useQueryClient();

  const listRuns = useServerFn(listReclassificationRuns);
  const undoRun = useServerFn(undoReclassificationRun);
  const { data, isLoading } = useQuery({
    queryKey: ["reclassification-runs"],
    queryFn: () => listRuns(),
  });
  const undoMut = useMutation({
    mutationFn: (sync_run_id: string) => undoRun({ data: { sync_run_id } }),
    onSuccess: (res) => {
      toast.success(
        `Reverted ${res.reverted} list(s)` +
          (res.skipped ? ` · ${res.skipped} skipped (changed since)` : ""),
      );
      void qc.invalidateQueries({ queryKey: ["reclassification-runs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Auto-reclassification history</CardTitle>
        <CardDescription>
          Undo a previous run that automatically converted trainee "solo" lists to
          "supervised". Rows changed manually since the run are left alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading runs…
          </div>
        ) : !data || data.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No auto-reclassification runs recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.runs.map((r) => (
              <li key={r.sync_run_id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {formatDateGB(new Date(r.created_at))}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({new Date(r.created_at).toLocaleTimeString()})
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {r.count} list(s) · {r.from_role} → {r.to_role} · run {r.sync_run_id.slice(0, 8)}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={undoMut.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Revert ${r.count} list(s) from "${r.to_role}" back to "${r.from_role}"?`,
                      )
                    ) {
                      undoMut.mutate(r.sync_run_id);
                    }
                  }}
                >
                  {undoMut.isPending && undoMut.variables === r.sync_run_id ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
