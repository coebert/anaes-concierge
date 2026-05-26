import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, RefreshCw, Plug } from "lucide-react";
import {
  getClwRotaSettings,
  saveClwRotaSettings,
  testClwRotaConnection,
  runClwRotaSync,
  syncClwRotaStaff,
} from "@/lib/clwrota.functions";
import { formatDateGB } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const getSettings = useServerFn(getClwRotaSettings);
  const saveSettings = useServerFn(saveClwRotaSettings);
  const testConn = useServerFn(testClwRotaConnection);
  const runSync = useServerFn(runClwRotaSync);
  const syncStaff = useServerFn(syncClwRotaStaff);

  const { data, isLoading } = useQuery({
    queryKey: ["clwrota-settings"],
    queryFn: () => getSettings(),
  });

  const [rotaUrl, setRotaUrl] = useState("");
  const [leaveUrl, setLeaveUrl] = useState("");
  const [staffUrl, setStaffUrl] = useState("");

  useEffect(() => {
    if (data?.settings) {
      setRotaUrl(data.settings.rota_report_url ?? "");
      setLeaveUrl(data.settings.leave_report_url ?? "");
      setStaffUrl(data.settings.staff_report_url ?? "");
    }
  }, [data?.settings]);

  const saveMut = useMutation({
    mutationFn: () =>
      saveSettings({
        data: {
          rota_report_url: rotaUrl.trim() || null,
          leave_report_url: leaveUrl.trim() || null,
          staff_report_url: staffUrl.trim() || null,
        },
      }),
    onSuccess: () => {
      toast.success("Report URLs saved");
      void qc.invalidateQueries({ queryKey: ["clwrota-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testMut = useMutation({
    mutationFn: () => testConn({}),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(`Connected (${res.status} in ${res.elapsedMs}ms)`);
      } else {
        toast.error(`Connection failed: ${res.status} ${res.statusText}`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncMut = useMutation({
    mutationFn: () => runSync({}),
    onSuccess: (res) => {
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      void qc.invalidateQueries({ queryKey: ["clwrota-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const staffMut = useMutation({
    mutationFn: () => syncStaff({}),
    onSuccess: (res) => {
      if (res.ok) toast.success(res.message);
      else toast.warning(res.message);
      void qc.invalidateQueries({ queryKey: ["clwrota-settings"] });
      void qc.invalidateQueries({ queryKey: ["staff"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const settings = data?.settings;
  const credsOk = data?.hasApiKey && data?.hasBaseUrl;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          CLWRota integration, curriculum targets, and email setup.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Plug className="h-4 w-4" /> CLWRota — pull sync
              </CardTitle>
              <CardDescription>
                Import rota, leave, and staff data from CLWRota into this app.
                Credentials are stored as backend secrets.
              </CardDescription>
            </div>
            <Badge variant={credsOk ? "default" : "destructive"}>
              {credsOk ? "Credentials set" : "Missing credentials"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">Base URL:</span>{" "}
              {data?.baseUrl ?? <em>not set</em>}
            </div>
            <div>
              <span className="font-medium text-foreground">API key:</span>{" "}
              {data?.hasApiKey ? "configured" : "not set"}
            </div>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              In CLWRota, generate a Central API report URL for each dataset
              and paste it below. Leave blank to skip a dataset.
            </p>

            <div className="space-y-2">
              <Label htmlFor="rota-url">Rota report URL</Label>
              <Input
                id="rota-url"
                placeholder="https://…/api/reports/rota.json?…"
                value={rotaUrl}
                onChange={(e) => setRotaUrl(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="leave-url">Leave report URL</Label>
              <Input
                id="leave-url"
                placeholder="https://…/api/reports/leave.json?…"
                value={leaveUrl}
                onChange={(e) => setLeaveUrl(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="staff-url">Staff report URL</Label>
              <Input
                id="staff-url"
                placeholder="https://…/api/reports/staff.json?…"
                value={staffUrl}
                onChange={(e) => setStaffUrl(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                {saveMut.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Save URLs
              </Button>
              <Button
                variant="outline"
                onClick={() => testMut.mutate()}
                disabled={testMut.isPending || !credsOk}
              >
                {testMut.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Test connection
              </Button>
              <Button
                variant="secondary"
                onClick={() => syncMut.mutate()}
                disabled={syncMut.isPending || !credsOk}
              >
                {syncMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                Run pull sync now
              </Button>
              <Button
                variant="default"
                onClick={() => staffMut.mutate()}
                disabled={staffMut.isPending || !credsOk || !staffUrl.trim()}
              >
                {staffMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                Sync staff now
              </Button>
            </div>
          </div>

          {staffMut.data && (
            <div className="rounded-md border border-border p-3 text-xs space-y-2">
              <div className="font-medium">Last staff sync</div>
              <div className="text-muted-foreground">
                {staffMut.data.total} rows · {staffMut.data.matched} matched ·{" "}
                {staffMut.data.updated} updated · {staffMut.data.unmatched.length} unmatched
              </div>
              {staffMut.data.unmatched.length > 0 && (
                <div>
                  <div className="font-medium text-foreground">Unmatched (need to be invited first):</div>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {staffMut.data.unmatched.slice(0, 20).map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                    {staffMut.data.unmatched.length > 20 && (
                      <li>…and {staffMut.data.unmatched.length - 20} more</li>
                    )}
                  </ul>
                </div>
              )}
              {staffMut.data.errors && staffMut.data.errors.length > 0 && (
                <div className="text-destructive">
                  Errors: {staffMut.data.errors.join("; ")}
                </div>
              )}
            </div>
          )}

          {settings?.last_sync_at && (
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="mb-1 flex items-center gap-2">
                {settings.last_status === "success" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
                <span className="font-medium">Last sync</span>
                <span className="text-muted-foreground">
                  {formatDateGB(settings.last_sync_at)} ·{" "}
                  {new Date(settings.last_sync_at).toLocaleTimeString("en-GB")}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                Status: {settings.last_status ?? "—"} · Rows pulled:{" "}
                {settings.last_pulled_rows ?? 0}
              </div>
              {settings.last_error && (
                <div className="mt-2 text-xs text-destructive">
                  {settings.last_error}
                </div>
              )}
            </div>
          )}

          {syncMut.data?.details && syncMut.data.details.length > 0 && (
            <div className="rounded-md border border-border p-3 text-xs">
              <div className="mb-1 font-medium">This run:</div>
              <ul className="space-y-1">
                {syncMut.data.details.map((d) => (
                  <li key={d.name} className="flex justify-between gap-2">
                    <span className="capitalize">{d.name}</span>
                    <span className="text-muted-foreground">
                      {d.error ? (
                        <span className="text-destructive">{d.error}</span>
                      ) : (
                        `${d.rows} rows · ${d.bytes} bytes`
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Note: this initial release fetches and counts rows from the
            configured CLWRota report URLs and records the result. Mapping the
            pulled rows into local rota / leave / staff records will be wired up
            once we see a sample payload from your CLWRota deployment — the
            field names vary per organisation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
