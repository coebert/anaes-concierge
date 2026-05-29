import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronLeft, AlertTriangle, ClipboardList, UserMinus, Briefcase, Coffee, Info } from "lucide-react";
import { formatDateGB, cn } from "@/lib/utils";
import {
  loadDayDetail, riskColor, riskLabel,
  type DayDetailSession, type HalfDayCapacity, type OtherDutyDetail,
} from "@/lib/audit/robustness";

export const Route = createFileRoute("/_authenticated/robustness/day/$date")({
  component: DayDetailPage,
});

function formatDuty(d: string): string {
  return d.replace(/_/g, " ");
}

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
    <TooltipProvider>
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
            Per-session coverage. Lists need a consultant (or ST6/ST7 solo).
            SAS and junior trainees pair with a consultant but cannot solo-cover.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          <HalfSummary label="AM" h={data.am} />
          <HalfSummary label="PM" h={data.pm} />
        </div>

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

        {(data.consultantsOnSpa.am.length > 0 || data.consultantsOnSpa.pm.length > 0) && (
          <Card className="border-orange-500/40">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Coffee className="h-4 w-4 text-orange-500" />
                Consultants on SPA (flexible cover)
              </CardTitle>
              <CardDescription>
                Could be redeployed onto a list, but pulling them disrupts their
                SPA time and should be flagged.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <SpaList label="AM" people={data.consultantsOnSpa.am} />
              <SpaList label="PM" people={data.consultantsOnSpa.pm} />
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <PeopleCard
            title={`On approved leave (${data.onLeave.length})`}
            icon={<UserMinus className="h-4 w-4 text-red-500" />}
            description="Annual / study / sick — unavailable all day."
          >
            {data.onLeave.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1 text-sm">
                {data.onLeave.map((l) => (
                  <li key={l.staffId} className="flex items-center justify-between rounded border px-2 py-1">
                    <span>{l.staffName}</span>
                    <span className="flex items-center gap-1.5 text-xs">
                      <GradeBadge grade={l.grade} trainingLevel={l.trainingLevel} />
                      <Badge variant="secondary" className="text-[10px]">{l.type}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </PeopleCard>

          <PeopleCard
            title={`On other duties (${data.onOtherDuty.length})`}
            icon={<Briefcase className="h-4 w-4 text-blue-500" />}
            description="On-call, ICU, obstetrics, teaching, admin — not available for lists."
          >
            {data.onOtherDuty.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1 text-sm">
                {data.onOtherDuty.map((l) => (
                  <li key={l.staffId + l.duty} className="flex items-center justify-between rounded border px-2 py-1">
                    <span>{l.staffName}</span>
                    <span className="flex items-center gap-1.5 text-xs">
                      <GradeBadge grade={l.grade} trainingLevel={l.trainingLevel} />
                      <Badge variant="outline" className="text-[10px] capitalize">{formatDuty(l.duty)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </PeopleCard>

          <PeopleCard
            title={`LTFT day off (${data.ltftOff.length})`}
            icon={<ClipboardList className="h-4 w-4 text-muted-foreground" />}
            description="Contracted non-working day."
          >
            {data.ltftOff.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1 text-sm">
                {data.ltftOff.map((l) => (
                  <li key={l.staffId} className="flex items-center justify-between rounded border px-2 py-1">
                    <span>{l.staffName}</span>
                    <GradeBadge grade={l.grade} trainingLevel={l.trainingLevel} />
                  </li>
                ))}
              </ul>
            )}
          </PeopleCard>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Empty() {
  return <div className="text-sm text-muted-foreground">Nobody.</div>;
}

function GradeBadge({ grade, trainingLevel }: { grade: string; trainingLevel: string | null }) {
  const label = grade === "trainee" && trainingLevel ? trainingLevel : grade;
  return <Badge variant="outline" className="text-[10px] capitalize">{label}</Badge>;
}

function SpaList({ label, people }: { label: string; people: OtherDutyDetail[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {people.length === 0 ? (
        <div className="text-sm text-muted-foreground">—</div>
      ) : (
        <ul className="space-y-1 text-sm">
          {people.map((p) => (
            <li key={p.staffId} className="rounded border border-orange-500/30 bg-orange-500/5 px-2 py-1">
              {p.staffName}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PeopleCard({
  title, icon, description, children,
}: {
  title: string;
  icon: React.ReactNode;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">{icon}{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function HalfSummary({ label, h }: { label: string; h: HalfDayCapacity }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>{label}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("rounded px-2 py-0.5 text-xs font-medium cursor-help", riskColor(h.risk))}>
                {riskLabel(h.risk)} · headroom {h.headroom}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="max-w-[18rem]">
                {riskLabel(h.risk)}: {h.soloCapable} solo-capable staff vs {h.required} lists.
                {h.consultantsOnSpa > 0 && ` ${h.consultantsOnSpa} consultant(s) on SPA could be flexed.`}
                {h.risk === "spa_required" && " A consultant currently on SPA would need to be pulled onto a list to fill the gap."}
                {h.risk === "shortfall" && " Even redeploying all SPA consultants would not cover every list."}
              </p>
            </TooltipContent>
          </Tooltip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <Stat label="Lists" value={h.required} tooltip="Theatre lists scheduled for this half-day." />
          <Stat label="Solo-capable" value={h.soloCapable} tooltip="Free consultants + ST6/7/8 trainees not already on a list. Only these can lead a new list alone." />
          <Stat label="Unfilled" value={h.unfilled} tooltip="Lists with no staff assigned yet." />
        </div>
        <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
          <Stat label="Consultants" value={h.consultantsAvailable} tooltip="Consultants free to deploy — not on leave, other duties, SPA, or already covering a list (theatre / POAC / pain clinic / any other clinical activity)." />
          <Stat label="ST6/7/8" value={h.seniorTraineesAvailable} tooltip="Senior trainees free to deploy — count as solo-capable. Trainees already covering a list or on ICU/obstetrics are excluded." />
          <Stat label="SAS" value={h.sasAvailable} tooltip="SAS doctors free to deploy — do not count toward headroom (cannot solo-cover)." />
          <Stat label="Jr trainees" value={h.juniorTraineesAvailable} tooltip="Junior trainees (ST1–ST5) free to deploy — can pair with a consultant but cannot lead a list alone." />
        </div>
        {h.consultantsOnSpa > 0 && (
          <div className="rounded border border-orange-500/40 bg-orange-500/10 px-2 py-1 text-xs">
            <Coffee className="mr-1 inline h-3 w-3 text-orange-600" />
            {h.consultantsOnSpa} consultant(s) on SPA — flexible cover available
            {h.risk === "spa_required" && " (REQUIRED to fill the gap)"}.
          </div>
        )}
        <div className="text-[11px] text-muted-foreground">
          {h.onLeave} on leave · {h.onOtherDuty} on other duties (on-call / ICU / obs / teaching)
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tooltip }: { label: string; value: number; tooltip?: string }) {
  const content = (
    <div className="rounded bg-muted/40 p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
  if (!tooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-help">{content}</div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="max-w-[16rem]">{tooltip}</p>
      </TooltipContent>
    </Tooltip>
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
                        <GradeBadge grade={a.grade} trainingLevel={a.trainingLevel} />
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
