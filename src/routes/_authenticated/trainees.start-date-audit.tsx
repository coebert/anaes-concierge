import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowLeft, AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { syncClwRotaLeave } from "@/lib/clwrota.functions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  getTraineeStartDateAudit,
  type AuditTrainee,
} from "@/lib/trainee-leave-audit.functions";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute(
  "/_authenticated/trainees/start-date-audit",
)({
  component: AuditGuard,
});

function AuditGuard() {
  const { hasRole, loading } = useAuth();
  if (loading) return null;
  if (!hasRole("admin")) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Admin only.
        </CardContent>
      </Card>
    );
  }
  return <AuditPage />;
}

function decisionBadge(decision: AuditTrainee["decision"]) {
  switch (decision) {
    case "not_yet_started":
      return <Badge variant="destructive">Not yet started</Badge>;
    case "has_counted_leave":
      return <Badge variant="secondary">Excluded by leave</Badge>;
    case "has_activity":
      return <Badge variant="outline">Active (has rota)</Badge>;
    case "no_signal":
      return <Badge variant="outline">No signal</Badge>;
  }
}

function AuditPage() {
  const fetchAudit = useServerFn(getTraineeStartDateAudit);
  const retryLeaveSync = useServerFn(syncClwRotaLeave);
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["trainee-start-date-audit"],
    queryFn: () => fetchAudit(),
  });

  const retry = useMutation({
    mutationFn: () => retryLeaveSync(),
    onSuccess: (res: unknown) => {
      const r = res as { status?: string; error?: string | null } | null;
      if (r?.status && r.status !== "ok") {
        toast.error(`Leave sync finished with status: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
      } else {
        toast.success("CLWRota leave sync completed");
      }
      queryClient.invalidateQueries({ queryKey: ["trainee-start-date-audit"] });
    },
    onError: (e: unknown) => {
      toast.error(`Leave sync failed: ${(e as Error).message}`);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Start-date prediction audit
          </h1>
          <p className="text-sm text-muted-foreground">
            Shows which leave records were considered (counted) or ignored when
            deciding whether each trainee has approved/pending leave overlapping
            the next two weeks.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/trainees">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to trainees
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Loading audit…
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {(error as Error).message}
          </CardContent>
        </Card>
      ) : !data ? null : (
        <>
          {data.leave_sources.warnings.length > 0 ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Leave data may be incomplete</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                  {data.leave_sources.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                <div className="mt-2 text-xs text-muted-foreground">
                  CLWRota last sync:{" "}
                  <span className="font-mono">
                    {data.leave_sources.clwrota_last_sync_at
                      ? `${data.leave_sources.clwrota_last_sync_at} (${formatDistanceToNow(
                          new Date(data.leave_sources.clwrota_last_sync_at),
                          { addSuffix: true },
                        )})`
                      : "never"}
                  </span>
                  {data.leave_sources.clwrota_last_status ? (
                    <>
                      {" · status: "}
                      <span className="font-mono">
                        {data.leave_sources.clwrota_last_status}
                      </span>
                    </>
                  ) : null}
                  {data.leave_sources.clwrota_last_error ? (
                    <>
                      {" · error: "}
                      <span className="font-mono">
                        {data.leave_sources.clwrota_last_error}
                      </span>
                    </>
                  ) : null}
                </div>
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => retry.mutate()}
                    disabled={retry.isPending}
                  >
                    <RefreshCw className={`mr-1 h-4 w-4 ${retry.isPending ? "animate-spin" : ""}`} />
                    {retry.isPending ? "Retrying sync…" : "Retry CLWRota leave sync"}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Decision window</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Scanning leave between{" "}
              <span className="font-mono">{data.window_start}</span> and{" "}
              <span className="font-mono">{data.window_end}</span>. A leave row
              <em> counts </em> only when its status is{" "}
              <code>approved</code> or <code>pending</code>. Cancelled, denied,
              or reserve-listed rows are ignored and do NOT prevent a trainee
              being flagged as "not yet started".
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Per-trainee audit ({data.trainees.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.trainees.map((t) => (
                <div
                  key={t.id}
                  className="rounded-md border p-3 space-y-2 bg-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Link
                        to="/trainees/$staffId"
                        params={{ staffId: t.id }}
                        className="font-medium hover:underline"
                      >
                        {t.full_name || t.email}
                      </Link>
                      {decisionBadge(t.decision)}
                      {t.leave_source_warnings.length > 0 ? (
                        <Badge
                          variant="destructive"
                          className="gap-1"
                          title={t.leave_source_warnings.join("\n")}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          Leave source issue
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground space-x-3">
                      <span>
                        Activity rows in window:{" "}
                        <span className="font-mono">{t.activity_count}</span>
                      </span>
                      <span>
                        Profile start:{" "}
                        <span className="font-mono">
                          {t.start_date ?? "—"}
                        </span>
                      </span>
                      <span>
                        Predicted next session:{" "}
                        <span className="font-mono">
                          {t.predicted_start ?? "—"}
                        </span>
                      </span>
                    </div>
                  </div>

                  {t.leave_source_warnings.length > 0 ? (
                    <ul className="list-disc space-y-0.5 rounded border border-destructive/30 bg-destructive/5 pl-5 py-1.5 text-xs text-destructive">
                      {t.leave_source_warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  ) : null}


                  {t.leave_rows.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      No leave records overlap the window.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Dates</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Counted?</TableHead>
                          <TableHead>Reason</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {t.leave_rows.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell className="text-xs font-mono">
                              {format(new Date(r.start_date), "d MMM yyyy")} →{" "}
                              {format(new Date(r.end_date), "d MMM yyyy")}
                            </TableCell>
                            <TableCell className="text-xs">{r.type}</TableCell>
                            <TableCell className="text-xs">
                              <Badge variant="outline">{r.status}</Badge>
                            </TableCell>
                            <TableCell>
                              {r.counted ? (
                                <Badge>Counted</Badge>
                              ) : (
                                <Badge variant="secondary">Ignored</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {r.classification_reason}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
