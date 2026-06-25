import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Clock, GraduationCap, Users } from "lucide-react";
import { formatDateGB, cn } from "@/lib/utils";
import {
  getLastMinuteChangesAudit,
  type StaffingGroup,
} from "@/lib/last-minute-changes.functions";

export const Route = createFileRoute(
  "/_authenticated/robustness/last-minute-changes",
)({
  component: LastMinuteChangesPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-4 text-sm text-destructive">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-4">Not found.</div>,
});

const GROUP_LABEL: Record<StaffingGroup, string> = {
  consultant: "Consultants",
  trainee:    "Trainees",
  sas:        "SAS doctors",
  anp:        "ANPs",
  other:      "Other",
  unknown:    "Unknown grade",
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function LastMinuteChangesPage() {
  const [rangeStart, setRangeStart] = useState(() => isoDaysAgo(90));
  const [rangeEnd, setRangeEnd] = useState(() => todayISO());

  const fetchAudit = useServerFn(getLastMinuteChangesAudit);
  const { data, isLoading, error } = useQuery({
    queryKey: ["last-minute-changes", rangeStart, rangeEnd],
    queryFn: () => fetchAudit({ data: { rangeStart, rangeEnd } }),
  });

  const groupRows = useMemo(() => {
    if (!data) return [];
    const order: StaffingGroup[] = ["consultant", "trainee", "sas", "anp", "other", "unknown"];
    return order
      .map((g) => ({ group: g, ...data.byGroup[g] }))
      .filter((r) => r.total > 0);
  }, [data]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Last minute changes audit
        </h1>
        <p className="text-sm text-muted-foreground">
          Counts every change to a rota assignment (insert, move or removal)
          made within <strong>48 hours</strong> of the scheduled start of the
          clinical activity. Trainees moved between lists inside the 48 hour
          window are highlighted separately.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Date range</CardTitle>
          <CardDescription>
            Filter by the <em>session date</em> of the affected clinical activity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="lmc-start">From</Label>
              <Input
                id="lmc-start"
                type="date"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lmc-end">To</Label>
              <Input
                id="lmc-end"
                type="date"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                className="w-44"
              />
            </div>
            <Badge variant="secondary">
              {formatDateGB(rangeStart)} – {formatDateGB(rangeEnd)}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {(error as Error).message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Total last-minute changes"
          value={data?.totals.all ?? (isLoading ? "…" : 0)}
          icon={Clock}
          tone="amber"
        />
        <Stat
          label="Reassignments / moves"
          value={data?.totals.updates ?? (isLoading ? "…" : 0)}
          icon={Users}
          tone="orange"
        />
        <Stat
          label="Inserts + removals"
          value={data
            ? data.totals.inserts + data.totals.deletes
            : (isLoading ? "…" : 0)}
          icon={AlertTriangle}
          tone="red"
        />
        <Stat
          label="Trainee changes (incl. list moves)"
          value={data?.totals.traineeListMoves ?? (isLoading ? "…" : 0)}
          icon={GraduationCap}
          tone="emerald"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By staffing group</CardTitle>
          <CardDescription>
            Last-minute changes split by the grade of the staff member whose
            assignment was changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : groupRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No last-minute changes recorded in this range.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staffing group</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Inserts</TableHead>
                  <TableHead className="text-right">Moves / updates</TableHead>
                  <TableHead className="text-right">Removals</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupRows.map((r) => (
                  <TableRow key={r.group}>
                    <TableCell className="font-medium">
                      {GROUP_LABEL[r.group]}
                      {r.group === "trainee" && (
                        <Badge variant="outline" className="ml-2">
                          tracks list moves
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.inserts}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.updates}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.deletes}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change log</CardTitle>
          <CardDescription>
            Most recent {data?.rows.length ?? 0} change(s) logged within the
            48 hour window. Negative hours mean the change happened after the
            session had already started.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (data?.rows.length ?? 0) === 0 ? (
            <div className="text-sm text-muted-foreground">No rows.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session date</TableHead>
                    <TableHead>Session</TableHead>
                    <TableHead>Staff</TableHead>
                    <TableHead>Group</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead className="text-right">Hours before</TableHead>
                    <TableHead>Changed at</TableHead>
                    <TableHead>Changed by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{formatDateGB(r.sessionDate)}</TableCell>
                      <TableCell className="uppercase text-xs">{r.session}</TableCell>
                      <TableCell>{r.staffName}</TableCell>
                      <TableCell>
                        <Badge variant={r.group === "trainee" ? "default" : "secondary"}>
                          {GROUP_LABEL[r.group]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "rounded px-2 py-0.5 text-xs font-medium",
                            r.action === "insert" && "bg-emerald-100 text-emerald-700",
                            r.action === "update" && "bg-amber-100 text-amber-700",
                            r.action === "delete" && "bg-red-100 text-red-700",
                          )}
                        >
                          {r.action}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.hoursBeforeSession.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.changedAt).toLocaleString("en-GB")}
                      </TableCell>
                      <TableCell className="text-xs">{r.changedByName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Source: <code>rota_change_log</code>. The database trigger logs every
        insert, update or delete on a rota assignment whose session start is
        within ±48 hours of the change. Historic entries before the trigger was
        widened may still reflect the previous ±24 hour window.
      </p>
    </div>
  );
}

type StatProps = {
  label: string;
  value: number | string;
  icon: typeof Clock;
  tone: "amber" | "red" | "emerald" | "orange";
};

function Stat({ label, value, icon: Icon, tone }: StatProps) {
  const toneClass =
    tone === "red" ? "bg-red-500/10 text-red-600"
    : tone === "amber" ? "bg-amber-500/10 text-amber-600"
    : tone === "orange" ? "bg-orange-500/10 text-orange-600"
    : "bg-emerald-500/10 text-emerald-600";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-md", toneClass)}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
