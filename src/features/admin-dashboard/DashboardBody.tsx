import { Fragment } from "react";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Users, GraduationCap, Stethoscope, UserCheck, UserX,
  CalendarDays, AlertTriangle, Clock, XCircle, ListChecks,
  ChevronDown, ChevronRight,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, Legend,
} from "recharts";
import { TraineeMetricsCard } from "@/components/trainee-metrics-card";
import { CalendarCoverageCard } from "@/components/calendar-coverage-card";
import {
  BUCKET_LABEL,
  GRADES,
  GRADE_LABEL,
  LEAVE_LABEL,
  LEAVE_TYPES,
  type TraineeBucket,
} from "@/features/admin/dashboard-helpers";
import { DualStat, Stat } from "@/routes/_authenticated/-admin-dashboard-stats";
import type { computeProgress } from "@/lib/competency-utils";
import type { computeTraineeMetrics } from "@/features/trainees/trainee-metrics";

// Progress row per trainee, matching the shape produced in the route.
type ProgressEntry = {
  overall: number | null;
  unmet: number;
  totalTargets: number;
  progress: ReturnType<typeof computeProgress>;
};

type TraineeMetricRow = {
  trainee: {
    id: string;
    full_name: string | null;
    training_level: string | null;
    start_date: string | null;
    rotation_end_date?: string | null;
  };
  icuOnly: boolean;
  metrics: ReturnType<typeof computeTraineeMetrics>;
};

export type DashboardBodyProps = {
  summary: {
    totalActive: number;
    totalAssigned: number;
    totalOnLeave: number;
    totalAvailable: number;
    assignedByGrade: Record<"consultant" | "sas" | "trainee", number>;
    availableByGrade: Record<
      "consultant" | "sas" | "trainee",
      { id: string; full_name: string | null; training_level: string | null }[]
    >;
    leaveByGradeType: Record<
      "consultant" | "sas" | "trainee",
      Record<"annual" | "sick" | "parental" | "study" | "compassionate" | "other", number>
    >;
    traineeSolo: Array<{ id: string; full_name: string | null; training_level: string | null }>;
  };
  activity: {
    lateRota: { d7: number; d30: number };
    rejected: { d7: number; d30: number };
    reserve: { d7: number; d30: number };
  } | undefined;
  annualLeaveStats: {
    chart: Array<{ label: string; consultantPct: number; traineePct: number }>;
    consultantAvg: number;
    traineeAvg: number;
    consultantsTracked: number;
    traineesTracked: number;
  } | undefined;
  soloStats: {
    chart: Array<{ label: string; soloLists: number; totalLists: number; avgPctSolo: number }>;
    traineeRows: Array<{
      id: string;
      full_name: string | null;
      level: string | null;
      solo: number;
      total: number;
      pct: number;
      onCall: number;
      totalAll: number;
      onCallPct: number;
    }>;
    totalSolo: number;
    totalLists: number;
    debugRows: Array<{
      trainee: string | null;
      date: string;
      session: string;
      role: string;
      theatre_session_id: string | null;
      hasConsultant: boolean;
      supervisor_id: string | null;
      supervisorIsConsultant: boolean;
      isSolo: boolean;
    }>;
  } | null;
  soloLoading: boolean;
  bucket: TraineeBucket;
  setBucket: (b: TraineeBucket) => void;
  showOnlyActive: boolean;
  setShowOnlyActive: (v: boolean) => void;
  expandedTrainee: string | null;
  setExpandedTrainee: (id: string | null) => void;
  progressByStaff: Map<string, ProgressEntry>;
  atRiskPct: number;
  behindPct: number;
  traineeMetricsLoading: boolean;
  traineeMetricRows: TraineeMetricRow[];
};

export function DashboardBody(props: DashboardBodyProps) {
  const {
    summary, activity, annualLeaveStats, soloStats, soloLoading,
    bucket, setBucket, showOnlyActive, setShowOnlyActive,
    expandedTrainee, setExpandedTrainee, progressByStaff,
    atRiskPct, behindPct, traineeMetricsLoading, traineeMetricRows,
  } = props;

  return (
    <>
      {/* Top-line totals */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active staff" value={summary.totalActive} icon={Users} />
        <Stat label="Assigned to work" value={summary.totalAssigned} icon={UserCheck} />
        <Stat label="On leave" value={summary.totalOnLeave} icon={UserX} />
        <Stat label="Available" value={summary.totalAvailable} icon={CalendarDays} />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Calendar coverage
        </h2>
        <CalendarCoverageCard />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Activity (rolling)
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DualStat label="Late rota changes (within 24h of session)" icon={Clock}
            d7={activity?.lateRota.d7} d30={activity?.lateRota.d30} />
          <DualStat label="Leave requests rejected" icon={XCircle}
            d7={activity?.rejected.d7} d30={activity?.rejected.d30} />
          <DualStat label="Placed on reserve leave list" icon={ListChecks}
            d7={activity?.reserve.d7} d30={activity?.reserve.d30} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">By grade</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {GRADES.map((g) => {
            const assigned = summary.assignedByGrade[g];
            const available = summary.availableByGrade[g];
            const onLeave = Object.values(summary.leaveByGradeType[g]).reduce((a, b) => a + b, 0);
            return (
              <Card key={g}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {g === "trainee" ? <GraduationCap className="h-4 w-4" /> : <Stethoscope className="h-4 w-4" />}
                    {GRADE_LABEL[g]}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Assigned</span><Badge>{assigned}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">On leave</span><Badge variant="secondary">{onLeave}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Available</span><Badge variant="outline">{available.length}</Badge>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Leave by type</h2>
        <Card>
          <CardContent className="p-0">
            <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
              {LEAVE_TYPES.map((t) => {
                const total = GRADES.reduce((a, g) => a + summary.leaveByGradeType[g][t], 0);
                return (
                  <div key={t} className="bg-card p-4">
                    <div className="mb-1 text-xs uppercase text-muted-foreground">{LEAVE_LABEL[t]}</div>
                    <div className="mb-2 text-2xl font-semibold">{total}</div>
                    <div className="flex flex-wrap gap-1 text-xs">
                      {GRADES.map((g) => (
                        <Badge key={g} variant="outline">
                          {GRADE_LABEL[g].split(" ")[0]}: {summary.leaveByGradeType[g][t]}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Annual leave taken — last 12 months
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Average % of each person's annual allowance used per month, by grade.
              {annualLeaveStats && (
                <> Tracking {annualLeaveStats.consultantsTracked} consultant(s) and {annualLeaveStats.traineesTracked} trainee(s) with a recorded allowance.</>
              )}
            </p>
          </div>
        </div>
        {!annualLeaveStats ? (
          <div className="text-sm text-muted-foreground">Loading annual leave data…</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Consultants — monthly avg</CardTitle></CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold tabular-nums">{annualLeaveStats.consultantAvg}%</div>
                <p className="text-xs text-muted-foreground">of annual allowance / month (12-mo avg)</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Trainees — monthly avg</CardTitle></CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold tabular-nums">{annualLeaveStats.traineeAvg}%</div>
                <p className="text-xs text-muted-foreground">of annual allowance / month (12-mo avg)</p>
              </CardContent>
            </Card>
            <Card className="lg:col-span-3">
              <CardHeader className="pb-2"><CardTitle className="text-base">Monthly trend</CardTitle></CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={annualLeaveStats.chart} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} unit="%" />
                      <Tooltip formatter={(v: number, name: string) => [`${v}%`, name === "consultantPct" ? "Consultants" : "Trainees"]} />
                      <Legend formatter={(v: string) => (v === "consultantPct" ? "Consultants" : "Trainees")} />
                      <Line type="monotone" dataKey="consultantPct" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
                      <Line type="monotone" dataKey="traineePct" stroke="hsl(var(--muted-foreground))" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Trainees working solo</h2>
        <Card>
          <CardContent className="p-4">
            {summary.traineeSolo.length === 0 ? (
              <p className="text-sm text-muted-foreground">No trainees flagged as solo on this date.</p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <span className="font-medium">{summary.traineeSolo.length} trainee(s) solo today</span>
                </div>
                <ul className="divide-y rounded-md border">
                  {summary.traineeSolo.map((p) => (
                    <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span>{p.full_name || "—"}</span>
                      {p.training_level && <Badge variant="secondary">{p.training_level}</Badge>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Solo trainee lists — last 12 months</h2>
            {soloStats && (
              <p className="mt-1 text-xs text-muted-foreground">
                {soloStats.totalSolo} solo of {soloStats.totalLists} daytime theatre lists
                {soloStats.totalLists > 0 && (
                  <> ({Math.round((soloStats.totalSolo / soloStats.totalLists) * 1000) / 10}%)</>
                )} · {BUCKET_LABEL[bucket]}
              </p>
            )}
          </div>
          <div className="w-48">
            <label className="mb-1 block text-xs text-muted-foreground">Training grade</label>
            <Select value={bucket} onValueChange={(v) => setBucket(v as TraineeBucket)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All trainees</SelectItem>
                <SelectItem value="junior">CT2–ST4</SelectItem>
                <SelectItem value="senior">ST5–ST8+</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {soloLoading || !soloStats ? (
          <div className="text-sm text-muted-foreground">Loading solo trainee data…</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Solo lists per month</CardTitle></CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={soloStats.chart} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                      <Tooltip
                        formatter={(value: number, name: string) => {
                          const label = name === "soloLists" ? "Solo lists" : name === "totalLists" ? "Total daytime lists" : name;
                          return [value, label];
                        }}
                      />
                      <Legend formatter={(v: string) => (v === "soloLists" ? "Solo" : "Total daytime")} />
                      <Bar dataKey="totalLists" fill="hsl(var(--muted-foreground))" opacity={0.35} />
                      <Bar dataKey="soloLists" fill="hsl(var(--primary))" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Avg % solo of trainee daytime lists</CardTitle></CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={soloStats.chart} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                      <Tooltip formatter={(v: number) => [`${v}%`, "Avg % solo"]} />
                      <Line type="monotone" dataKey="avgPctSolo" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Per-trainee summary (12 months)</CardTitle>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="show-only-active"
                      checked={showOnlyActive}
                      onCheckedChange={(checked) => setShowOnlyActive(checked === true)}
                    />
                    <Label htmlFor="show-only-active" className="text-xs font-normal cursor-pointer">
                      Show only active
                    </Label>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {soloStats.traineeRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No data for this grade bucket.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="py-2 pr-2 w-6" />
                          <th className="py-2 pr-3">Trainee</th>
                          <th className="py-2 pr-3">Level</th>
                          <th className="py-2 pr-3 text-right">Solo</th>
                          <th className="py-2 pr-3 text-right">Daytime lists</th>
                          <th className="py-2 pr-3 text-right">% solo</th>
                          <th className="py-2 pr-3 text-right">On-call</th>
                          <th className="py-2 pr-3 text-right">Total</th>
                          <th className="py-2 pr-3 text-right">% on-call</th>
                        </tr>
                      </thead>
                      <tbody>
                        {soloStats.traineeRows
                          .filter((r) => !showOnlyActive || r.total > 0)
                          .map((r) => {
                            const prog = progressByStaff.get(r.id);
                            const isActive = r.total > 0;
                            const behind =
                              isActive && prog && prog.totalTargets > 0 && prog.overall !== null && prog.overall < behindPct;
                            const atRisk =
                              isActive && prog && prog.totalTargets > 0 && prog.overall !== null && prog.overall < atRiskPct;
                            const canExpand = !!prog && prog.totalTargets > 0;
                            const isExpanded = expandedTrainee === r.id;
                            return (
                              <Fragment key={r.id}>
                                <tr
                                  className={`border-t ${canExpand ? "cursor-pointer hover:bg-muted/40" : ""} ${atRisk ? "bg-destructive/5" : behind ? "bg-amber-500/5" : ""}`}
                                  onClick={() =>
                                    canExpand &&
                                    setExpandedTrainee(isExpanded ? null : r.id)
                                  }
                                >
                                  <td className="py-1.5 pr-2 text-muted-foreground">
                                    {canExpand ? (
                                      isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
                                    ) : null}
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    <span className={!isActive ? "text-muted-foreground" : ""}>{r.full_name || "—"}</span>
                                    {!isActive && (<Badge variant="outline" className="ml-2 text-[10px]">Inactive</Badge>)}
                                    {atRisk && (
                                      <Badge variant="destructive" className="ml-2 text-[10px] gap-1">
                                        <AlertTriangle className="h-3 w-3" />At risk · {prog!.overall}%
                                      </Badge>
                                    )}
                                    {behind && !atRisk && (
                                      <Badge variant="outline" className="ml-2 text-[10px] gap-1 border-amber-500 text-amber-700 dark:text-amber-400">
                                        <AlertTriangle className="h-3 w-3" />Behind · {prog!.overall}%
                                      </Badge>
                                    )}
                                    {isActive && prog && prog.totalTargets > 0 && prog.unmet > 0 && !behind && (
                                      <Badge variant="secondary" className="ml-2 text-[10px]">
                                        {prog.unmet}/{prog.totalTargets} targets unmet
                                      </Badge>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 text-muted-foreground">{r.level || "—"}</td>
                                  <td className="py-1.5 pr-3 text-right">{r.solo}</td>
                                  <td className="py-1.5 pr-3 text-right">{r.total}</td>
                                  <td className="py-1.5 pr-3 text-right font-medium">{r.total > 0 ? `${r.pct}%` : "N/A"}</td>
                                  <td className="py-1.5 pr-3 text-right">{r.onCall}</td>
                                  <td className="py-1.5 pr-3 text-right">{r.totalAll}</td>
                                  <td className="py-1.5 pr-3 text-right font-medium">{r.totalAll > 0 ? `${r.onCallPct}%` : "N/A"}</td>
                                </tr>
                                {isExpanded && prog && (
                                  <tr className="border-t bg-muted/20">
                                    <td />
                                    <td colSpan={8} className="py-3 pr-3">
                                      <div className="space-y-2">
                                        <div className="text-xs font-medium text-muted-foreground">
                                          Training targets ({r.level || "—"}) — {prog.totalTargets - prog.unmet}/{prog.totalTargets} met
                                        </div>
                                        <div className="overflow-x-auto">
                                          <table className="w-full text-xs">
                                            <thead className="text-left text-muted-foreground">
                                              <tr>
                                                <th className="py-1 pr-3">Specialty</th>
                                                <th className="py-1 pr-3 text-right">Solo</th>
                                                <th className="py-1 pr-3 text-right">Supervised</th>
                                                <th className="py-1 pr-3 text-right">Total</th>
                                                <th className="py-1 pr-3 text-right">Progress</th>
                                                <th className="py-1 pr-3">Status</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {prog.progress
                                                .slice()
                                                .sort((a, b) => a.percent - b.percent)
                                                .map((p) => {
                                                  const reqTotal = p.required_sessions || p.required_solo + p.required_supervised;
                                                  const unmet = p.percent < 100;
                                                  return (
                                                    <tr key={p.specialty_id} className="border-t border-muted">
                                                      <td className="py-1 pr-3">{p.specialty_name}</td>
                                                      <td className="py-1 pr-3 text-right tabular-nums">
                                                        <span className={p.done_solo < p.required_solo ? "text-destructive font-medium" : ""}>{p.done_solo}</span>
                                                        <span className="text-muted-foreground"> / {p.required_solo}</span>
                                                      </td>
                                                      <td className="py-1 pr-3 text-right tabular-nums">
                                                        <span className={p.done_supervised < p.required_supervised ? "text-destructive font-medium" : ""}>{p.done_supervised}</span>
                                                        <span className="text-muted-foreground"> / {p.required_supervised}</span>
                                                      </td>
                                                      <td className="py-1 pr-3 text-right tabular-nums">
                                                        <span className={p.done_total < reqTotal ? "text-destructive font-medium" : ""}>{p.done_total}</span>
                                                        <span className="text-muted-foreground"> / {reqTotal}</span>
                                                      </td>
                                                      <td className="py-1 pr-3 text-right tabular-nums font-medium">{p.percent}%</td>
                                                      <td className="py-1 pr-3">
                                                        {unmet ? (
                                                          <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">Unmet</Badge>
                                                        ) : (
                                                          <Badge variant="secondary" className="text-[10px]">Met</Badge>
                                                        )}
                                                      </td>
                                                    </tr>
                                                  );
                                                })}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
        {soloStats && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Debug: solo detection per assignment</CardTitle>
              <p className="text-xs text-muted-foreground">
                Showing first 300 trainee assignments with intermediate values used to compute solo.
              </p>
            </CardHeader>
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm">Show / hide ({soloStats.debugRows.length} rows)</summary>
                <div className="mt-2 max-h-[500px] overflow-auto">
                  <table className="w-full text-xs font-mono">
                    <thead className="text-left uppercase text-muted-foreground sticky top-0 bg-background">
                      <tr>
                        <th className="py-1 pr-2">Trainee</th>
                        <th className="py-1 pr-2">Date</th>
                        <th className="py-1 pr-2">Sess</th>
                        <th className="py-1 pr-2">role_on_list</th>
                        <th className="py-1 pr-2">theatre_session_id</th>
                        <th className="py-1 pr-2">hasConsultant</th>
                        <th className="py-1 pr-2">supervisor_id</th>
                        <th className="py-1 pr-2">supIsCons</th>
                        <th className="py-1 pr-2">isSolo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {soloStats.debugRows.slice(0, 300).map((r, i) => (
                        <tr key={i} className="border-t">
                          <td className="py-1 pr-2">{r.trainee || "—"}</td>
                          <td className="py-1 pr-2">{r.date}</td>
                          <td className="py-1 pr-2">{r.session}</td>
                          <td className="py-1 pr-2">{r.role}</td>
                          <td className="py-1 pr-2">{r.theatre_session_id ? r.theatre_session_id.slice(0, 8) : "—"}</td>
                          <td className="py-1 pr-2">{String(r.hasConsultant)}</td>
                          <td className="py-1 pr-2">{r.supervisor_id ? r.supervisor_id.slice(0, 8) : "—"}</td>
                          <td className="py-1 pr-2">{String(r.supervisorIsConsultant)}</td>
                          <td className="py-1 pr-2 font-bold">{String(r.isSolo)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </CardContent>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Available to assign</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {GRADES.map((g) => (
            <Card key={g}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {GRADE_LABEL[g]} ({summary.availableByGrade[g].length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {summary.availableByGrade[g].length === 0 ? (
                  <p className="text-sm text-muted-foreground">None available.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {summary.availableByGrade[g].map((p) => (
                      <li key={p.id} className="flex items-center justify-between">
                        <span>{p.full_name || "—"}</span>
                        {p.training_level && (<Badge variant="outline" className="text-xs">{p.training_level}</Badge>)}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Per-trainee metrics (all-time)</h2>
        {traineeMetricsLoading ? (
          <div className="text-sm text-muted-foreground">Loading trainee metrics…</div>
        ) : traineeMetricRows.length === 0 ? (
          <div className="text-sm text-muted-foreground">No active trainees on record.</div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {traineeMetricRows.map(({ trainee, metrics, icuOnly }) => (
              <TraineeMetricsCard
                key={trainee.id}
                title={trainee.full_name || "—"}
                subtitle={trainee.training_level ?? "No level set"}
                metrics={metrics}
                startDate={trainee.start_date}
                rotationEndDate={trainee.rotation_end_date ?? null}
                icuBlockOnly={icuOnly}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
