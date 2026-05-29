import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, AlertTriangle, ClipboardList, UserMinus } from "lucide-react";
import { formatDateGB, cn } from "@/lib/utils";
import { loadDayDetail, riskColor, type DayDetailSession } from "@/lib/audit/robustness";
import { loadDayDetail, riskColor, type DayDetailSession, type HalfDayCapacity } from "@/lib/audit/robustness";

export const Route = createFileRoute("/_authenticated/robustness/day/$date")({
  component: DayDetailPage,
});

function DayDetailPage() {
  const { date } = Route.useParams();
  const { data, isLoading } = useQuery({
    queryKey: ["robustness-day", date],
    queryFn: () => loadDayDetail(date),
  });

  if (isLoading || !data) {
    return <div className="text-sm text-muted-foreground">Loading day detail…</div>;
  }

  const amSessions = data.sessions.filter((s) => s.session === "am");
  const pmSessions = data.sessions.filter((s) => s.session === "pm");
  const totalUnfilled = data.sessions.filter((s) => s.unfilled).length;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="text-xs">
          <Link to="/robustness" className="text-muted-foreground hover:underline">
            <ChevronLeft className="mr-1 inline h-3 w-3" />
            Back to robustness report
          </Link>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {formatDateGB(data.date)}
        </h1>
        <p className="text-sm text-muted-foreground">
          Per-session coverage and the people pulling headroom down.
        </p>
      </header>

      {/* Headroom summary */}
      <div className="grid gap-4 sm:grid-cols-2">
        <HalfSummary label="AM" h={data.am} />
        <HalfSummary label="PM" h={data.pm} />
      </div>

      {/* Theatre session lists */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SessionsCard title="AM theatre lists" sessions={amSessions} />
        <SessionsCard title="PM theatre lists" sessions={pmSessions} />
      </div>

      {totalUnfilled > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-50/40 p-3 text-sm dark:bg-amber-950/20">
          <AlertTriangle className="mr-1 inline h-4 w-4 text-amber-600" />
          {totalUnfilled} theatre session(s) have no staff assigned yet.
        </div>
      )}

      {/* Headroom drag-down lists */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <UserMinus className="h-4 w-4 text-red-500" />
              On approved leave ({data.onLeave.length})
            </CardTitle>
            <CardDescription>Each of these drops headroom by 1.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.onLeave.length === 0 ? (
              <div className="text-sm text-muted-foreground">Nobody.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.onLeave.map((l) => (
                  <li key={l.staffId} className="flex items-center justify-between rounded border px-2 py-1">
                    <span>{l.staffName}</span>
                    <span className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="capitalize">{l.grade}</Badge>
                      <Badge variant="secondary">{l.type}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              LTFT day off ({data.ltftOff.length})
            </CardTitle>
            <CardDescription>Contracted non-working day for this weekday.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.ltftOff.length === 0 ? (
              <div className="text-sm text-muted-foreground">Nobody.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.ltftOff.map((l) => (
                  <li key={l.staffId} className="flex items-center justify-between rounded border px-2 py-1">
                    <span>{l.staffName}</span>
                    <Badge variant="outline" className="capitalize text-xs">{l.grade}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function HalfSummary({ label, h }: { label: string; h: HalfDayCapacity }) {

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>{label}</span>
          <span className={cn("rounded px-2 py-0.5 text-xs font-medium", riskColor(h.risk))}>
            headroom {h.headroom}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-2 text-center text-xs">
        <Stat label="Required" value={h.required} />
        <Stat label="Available" value={h.available} />
        <Stat label="Unfilled" value={h.unfilled} />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-muted/40 p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

function SessionsCard({ title, sessions }: { title: string; sessions: DayDetailSession[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{sessions.length} list(s) scheduled.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {sessions.length === 0 ? (
          <div className="text-sm text-muted-foreground">No lists scheduled.</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={cn(
                "rounded-md border p-2 text-sm",
                s.unfilled && "border-red-500/50 bg-red-500/5",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">{s.theatreName}</div>
                {s.unfilled ? (
                  <Badge variant="destructive" className="text-[10px]">UNFILLED</Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    {s.assignments.length} assigned
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.specialty ?? "—"}
                {s.surgicalConsultant ? ` · ${s.surgicalConsultant}` : ""}
              </div>
              {s.assignments.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {s.assignments.map((a, i) => (
                    <li key={i} className="flex items-center justify-between">
                      <span>{a.staffName}</span>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="capitalize">{a.role}</span>
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {a.grade}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
