import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ChevronLeft, Calculator, AlertTriangle, CheckCircle2, Info,
} from "lucide-react";
import { calculateFeasibility } from "@/lib/consultant-feasibility";

export const Route = createFileRoute(
  "/_authenticated/robustness/consultant-feasibility",
)({
  component: ConsultantFeasibilityPage,
});

// Per-field bounds. Kept generous but enough to catch typos / nonsense.
const InputsSchema = z.object({
  mainTheatres: z.number().int("Whole number").min(0).max(50),
  daySurgeryTheatres: z.number().int("Whole number").min(0).max(50),
  sessionsPerTheatrePerWeek: z.number().min(0).max(21, "Max 21 (3/day × 7 days)"),
  labourWardSessionsPerWeek: z.number().min(0).max(21),
  consultantInChargeSessionsPerWeek: z.number().min(0).max(21),
  painServiceSessionsPerWeek: z.number().min(0).max(50),
  poacSessionsPerWeek: z.number().min(0).max(50),
  nonClinicalPAsPerWeek: z.number().min(0).max(50),
  icuSessionsPerWeek: z.number().min(0).max(21),
  icuTrainedPoolSize: z.number().int("Whole number").min(0).max(200),
  pasPerConsultant: z.number().min(1, "Must be ≥ 1").max(15, "Max 15 PAs/week"),
  dccPasPerConsultant: z.number().min(0).max(15),
  sessionsPerPa: z.number().min(0.1, "Must be > 0").max(2, "Max 2 sessions/PA"),
  annualLeaveDays: z.number().min(0).max(70),
  studyLeaveDays: z.number().min(0).max(40),
  bankHolidayDays: z.number().min(0).max(20),
  weeksPerYear: z.number().min(1).max(53),
  workingDaysPerWeek: z.number().min(1, "Must be ≥ 1").max(7),
  sicknessRatePct: z.number().min(0).max(30, "Max 30%"),
  theatreOnCallPAsPerWeek: z.number().min(0).max(20, "Max 20 PAs/wk"),
  icuOnCallPAsPerWeek: z.number().min(0).max(20, "Max 20 PAs/wk"),
}).refine((v) => v.dccPasPerConsultant <= v.pasPerConsultant, {
  message: "DCC PAs cannot exceed total PAs",
  path: ["dccPasPerConsultant"],
});

type Inputs = z.infer<typeof InputsSchema>;
type FieldErrors = Partial<Record<keyof Inputs, string>>;



const DEFAULTS: Inputs = {
  mainTheatres: 10,
  daySurgeryTheatres: 3,
  sessionsPerTheatrePerWeek: 10,
  labourWardSessionsPerWeek: 10,
  consultantInChargeSessionsPerWeek: 10,
  painServiceSessionsPerWeek: 5,
  poacSessionsPerWeek: 5,
  nonClinicalPAsPerWeek: 0,
  icuSessionsPerWeek: 10,
  icuTrainedPoolSize: 10,
  pasPerConsultant: 10,
  dccPasPerConsultant: 7.5,
  sessionsPerPa: 1,
  annualLeaveDays: 32,
  studyLeaveDays: 7,
  bankHolidayDays: 8,
  weeksPerYear: 52,
  workingDaysPerWeek: 5,
  sicknessRatePct: 5,
  theatreOnCallPAsPerWeek: 2,
  icuOnCallPAsPerWeek: 2,
};

function ConsultantFeasibilityPage() {
  const [inp, setInp] = useState<Inputs>(DEFAULTS);

  const calc = useMemo(() => calculateFeasibility(inp), [inp]);

  const errors: FieldErrors = useMemo(() => {
    const result = InputsSchema.safeParse(inp);
    if (result.success) return {};
    const out: FieldErrors = {};
    for (const issue of result.error.issues) {
      const key = issue.path[0] as keyof Inputs | undefined;
      if (key && !out[key]) out[key] = issue.message;
    }
    return out;
  }, [inp]);
  const hasErrors = Object.keys(errors).length > 0;

  const set = <K extends keyof Inputs>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const v = raw === "" ? 0 : Number(raw);
      setInp((prev) => ({ ...prev, [key]: Number.isFinite(v) ? v : 0 }));
    };

  const icuFeasible = calc.icuPoolUtilisation <= 1;


  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Button asChild variant="ghost" size="sm" className="h-7 px-2">
              <Link to="/robustness">
                <ChevronLeft className="mr-1 h-4 w-4" /> Robustness
              </Link>
            </Button>
          </div>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Calculator className="h-6 w-6 text-primary" />
            Consultant workforce feasibility
          </h1>
          <p className="text-sm text-muted-foreground">
            How many full-time consultants are needed to cover the standing
            theatre, labour-ward and ICU commitments?
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setInp(DEFAULTS)}>
          Reset to defaults
        </Button>
      </header>

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Info className="h-4 w-4 text-primary" />
            How this calculation works
          </CardTitle>
          <CardDescription>
            Every figure on the page is derived from these explicit rules — change any input to see the effect.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              <strong className="text-foreground">Session demand</strong> = (main + day-surgery theatres) × sessions/theatre/week + labour-ward sessions/week + ICU sessions/week.
            </li>
            <li>
              <strong className="text-foreground">A "session"</strong> is a half-day list (AM or PM). Mon–Fri AM+PM = 10 sessions/theatre/week.
            </li>
            <li>
              <strong className="text-foreground">On-call cover</strong>: one consultant covers theatres OOH and one ICU-trained consultant covers ICU OOH at all times. The PAs allocated to each rota (per week) are converted to session-equivalents via "sessions / PA" and added to demand — these PAs are drawn from the DCC pool so they reduce list-running capacity.
            </li>
            <li>
              <strong className="text-foreground">Per-consultant capacity</strong>: only DCC PAs count toward clinical sessions (SPA time excluded). Sessions/week = DCC PAs × sessions per PA.
            </li>
            <li>
              <strong className="text-foreground">Leave treatment</strong>: annual + study + bank-holiday days are summed and divided by working-days/week to convert into weeks lost. Working weeks/year = weeks/year − leave weeks.
            </li>
            <li>
              <strong className="text-foreground">Sickness</strong>: capacity per consultant is derated by the sickness rate (e.g. 5% sickness ⇒ multiply annual sessions/consultant by 0.95).
            </li>
            <li>
              <strong className="text-foreground">FTE needed</strong> = (annual session demand + annual on-call session-equivalents) ÷ (weekly clinical sessions × working weeks/year × (1 − sickness)). Headcount is the FTE rounded up.
            </li>
            <li>
              <strong className="text-foreground">ICU subgroup check</strong>: ICU sessions and ICU OOH cover can only be drawn from the ICU-trained pool. Pool utilisation = ICU annual demand ÷ (pool size × per-consultant annual capacity). Must be ≤ 100% to be feasible.
            </li>
            <li>
              <strong className="text-foreground">Not modelled</strong>: parental leave, fixed sessions, LTFT, weekend elective lists, cross-cover for individual absences, on-call rota size effects (compensatory rest).
            </li>
          </ul>
        </CardContent>
      </Card>

      {hasErrors && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Check your inputs</AlertTitle>
          <AlertDescription>
            One or more values are out of range. The result below is hidden until they are corrected.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Demand assumptions</CardTitle>
            <CardDescription>
              Weekly clinical sessions that must be staffed.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <Field label="Main theatres" value={inp.mainTheatres} onChange={set("mainTheatres")} error={errors.mainTheatres} />
            <Field label="Day-surgery theatres" value={inp.daySurgeryTheatres} onChange={set("daySurgeryTheatres")} error={errors.daySurgeryTheatres} />
            <Field label="Sessions / theatre / week" value={inp.sessionsPerTheatrePerWeek} onChange={set("sessionsPerTheatrePerWeek")} hint="AM+PM Mon–Fri = 10" error={errors.sessionsPerTheatrePerWeek} />
            <Field label="Labour-ward sessions / week" value={inp.labourWardSessionsPerWeek} onChange={set("labourWardSessionsPerWeek")} error={errors.labourWardSessionsPerWeek} />
            <Field label="Consultant-in-charge sess / wk" value={inp.consultantInChargeSessionsPerWeek} onChange={set("consultantInChargeSessionsPerWeek")} hint="AM+PM Mon–Fri = 10" error={errors.consultantInChargeSessionsPerWeek} />
            <Field label="Pain service sess / wk" value={inp.painServiceSessionsPerWeek} step="0.5" onChange={set("painServiceSessionsPerWeek")} hint="Acute pain + pain clinics" error={errors.painServiceSessionsPerWeek} />
            <Field label="POAC sess / wk" value={inp.poacSessionsPerWeek} step="0.5" onChange={set("poacSessionsPerWeek")} hint="Pre-op assessment" error={errors.poacSessionsPerWeek} />
            <Field label="Non-clinical PAs / wk" value={inp.nonClinicalPAsPerWeek} step="0.5" onChange={set("nonClinicalPAsPerWeek")} hint="Mgmt / governance / audit — deducted from clinical cover" error={errors.nonClinicalPAsPerWeek} />
            <Field label="ICU sessions / week" value={inp.icuSessionsPerWeek} onChange={set("icuSessionsPerWeek")} error={errors.icuSessionsPerWeek} />
            <Field label="ICU-trained pool size" value={inp.icuTrainedPoolSize} onChange={set("icuTrainedPoolSize")} error={errors.icuTrainedPoolSize} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-consultant capacity</CardTitle>
            <CardDescription>
              Job plan and leave assumptions per full-time consultant.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <Field label="PAs / week (total)" value={inp.pasPerConsultant} step="0.5" onChange={set("pasPerConsultant")} hint="Standard NHS contract = 10" error={errors.pasPerConsultant} />
            <Field label="DCC PAs / week" value={inp.dccPasPerConsultant} step="0.5" onChange={set("dccPasPerConsultant")} hint="Clinical, excludes SPA" error={errors.dccPasPerConsultant} />
            <Field label="Sessions / PA" value={inp.sessionsPerPa} step="0.5" onChange={set("sessionsPerPa")} hint="1 PA = 1 half-day list" error={errors.sessionsPerPa} />
            <Field label="Annual leave (days)" value={inp.annualLeaveDays} onChange={set("annualLeaveDays")} error={errors.annualLeaveDays} />
            <Field label="Study leave (days)" value={inp.studyLeaveDays} onChange={set("studyLeaveDays")} error={errors.studyLeaveDays} />
            <Field label="Bank holidays (days)" value={inp.bankHolidayDays} onChange={set("bankHolidayDays")} error={errors.bankHolidayDays} />
            <Field label="Weeks / year" value={inp.weeksPerYear} onChange={set("weeksPerYear")} error={errors.weeksPerYear} />
            <Field label="Working days / week" value={inp.workingDaysPerWeek} onChange={set("workingDaysPerWeek")} hint="Used to convert leave days → weeks" error={errors.workingDaysPerWeek} />
            <Field label="Sickness rate (%)" value={inp.sicknessRatePct} step="0.5" onChange={set("sicknessRatePct")} hint="Derates annual capacity" error={errors.sicknessRatePct} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-call cover (24/7)</CardTitle>
          <CardDescription>
            One consultant always covering theatres OOH, and one ICU-trained
            consultant always covering ICU OOH. The PAs allocated to each rota
            are taken from the DCC pool.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Theatre on-call PAs / week" value={inp.theatreOnCallPAsPerWeek} step="0.5" onChange={set("theatreOnCallPAsPerWeek")} hint="Total rota PAs/wk" error={errors.theatreOnCallPAsPerWeek} />
          <Field label="ICU on-call PAs / week" value={inp.icuOnCallPAsPerWeek} step="0.5" onChange={set("icuOnCallPAsPerWeek")} hint="Drawn from ICU-trained pool" error={errors.icuOnCallPAsPerWeek} />
        </CardContent>
      </Card>



      {!hasErrors && (<>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Result</CardTitle>
          <CardDescription>
            Derived from the inputs above. Adjust any field to re-run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Weekly session-equivalents to cover"
              value={calc.weeklyDemand.toFixed(1)}
              sub={`${calc.weeklySessionDemand} lists + ${(calc.weeklyOnCallPAs * inp.sessionsPerPa).toFixed(1)} on-call (${calc.weeklyOnCallPAs} PAs)`}
            />
            <Stat
              label="Annual session-equivalents"
              value={Math.round(calc.annualDemand).toLocaleString()}
              sub={`${calc.weeklyDemand.toFixed(1)} × ${inp.weeksPerYear} weeks (incl. on-call)`}
            />
            <Stat
              label="Sessions / consultant / year"
              value={calc.annualSessionsPerConsultant.toFixed(1)}
              sub={`${calc.weeklyClinicalSessions} sess/wk × ${calc.workingWeeks.toFixed(1)} wks × ${(calc.sicknessFactor * 100).toFixed(0)}% (sickness ${inp.sicknessRatePct}%)`}
            />
          </div>

          <Separator />

          <div className="rounded-lg border bg-primary/5 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Full-time consultants required
                </div>
                <div className="mt-1 text-4xl font-semibold tracking-tight">
                  {calc.fteNeeded.toFixed(1)}
                  <span className="ml-2 text-base font-normal text-muted-foreground">
                    FTE
                  </span>
                </div>
              </div>
              <Badge variant="secondary" className="text-sm">
                Round up to {Math.ceil(calc.fteNeeded)} headcount
              </Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Annual demand ÷ annual capacity per consultant
              ={" "}
              {Math.round(calc.annualDemand).toLocaleString()} ÷{" "}
              {calc.annualSessionsPerConsultant.toFixed(1)}.
            </p>
          </div>

          <div
            className={
              "rounded-lg border p-4 " +
              (icuFeasible
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-destructive/40 bg-destructive/5")
            }
          >
            <div className="flex items-start gap-2">
              {icuFeasible ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
              ) : (
                <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
              )}
              <div className="space-y-1 text-sm">
                <div className="font-medium">
                  ICU subgroup constraint:{" "}
                  {icuFeasible ? "feasible" : "INFEASIBLE"} at{" "}
                  {(calc.icuPoolUtilisation * 100).toFixed(1)}% utilisation
                </div>
                <p className="text-muted-foreground">
                  {inp.icuSessionsPerWeek} ICU sessions/week + {inp.icuOnCallPAsPerWeek} ICU on-call PAs/week must be drawn from
                  the {inp.icuTrainedPoolSize}-strong ICU-trained pool. Each
                  ICU-trained consultant would spend{" "}
                  <strong>
                    {(calc.icuSharePerConsultant * 100).toFixed(1)}%
                  </strong>{" "}
                  of their clinical time on ICU + ICU on-call, leaving the
                  remainder for theatres / labour ward.
                </p>
                <p className="text-muted-foreground">
                  Annual ICU demand{" "}
                  {Math.round(calc.icuAnnualDemand).toLocaleString()} (incl.{" "}
                  {Math.round(calc.icuAnnualOnCallEquiv).toLocaleString()} on-call) vs pool
                  capacity{" "}
                  {Math.round(calc.icuPoolAnnualCapacity).toLocaleString()}{" "}
                  sessions/year.
                </p>
              </div>
            </div>
          </div>

          <details className="rounded-lg border p-4 text-sm">
            <summary className="cursor-pointer font-medium">
              Show working
            </summary>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              <li>
                Theatres: ({inp.mainTheatres} main + {inp.daySurgeryTheatres}{" "}
                day-surgery) × {inp.sessionsPerTheatrePerWeek} sessions/wk ={" "}
                <strong>{calc.theatreSessions}</strong> sessions/wk
              </li>
              <li>
                Weekly session demand = {calc.theatreSessions} theatre +{" "}
                {inp.labourWardSessionsPerWeek} labour ward +{" "}
                {inp.consultantInChargeSessionsPerWeek} consultant-in-charge +{" "}
                {inp.painServiceSessionsPerWeek} pain +{" "}
                {inp.poacSessionsPerWeek} POAC +{" "}
                {inp.nonClinicalPAsPerWeek} non-clinical PAs ×{" "}
                {inp.sessionsPerPa} +{" "}
                {inp.icuSessionsPerWeek} ICU ={" "}
                <strong>{calc.weeklySessionDemand}</strong>
              </li>
              <li>
                On-call: ({inp.theatreOnCallPAsPerWeek} theatre +{" "}
                {inp.icuOnCallPAsPerWeek} ICU) PAs/wk × {inp.sessionsPerPa}{" "}
                sess/PA ={" "}
                <strong>
                  {(calc.weeklyOnCallPAs * inp.sessionsPerPa).toFixed(1)}
                </strong>{" "}
                session-equiv/wk
              </li>
              <li>
                Total weekly demand ={" "}
                <strong>{calc.weeklyDemand.toFixed(1)}</strong> × {inp.weeksPerYear} wks ={" "}
                <strong>{Math.round(calc.annualDemand).toLocaleString()}</strong>/yr
              </li>
              <li>
                Leave per consultant: {inp.annualLeaveDays} AL +{" "}
                {inp.studyLeaveDays} study + {inp.bankHolidayDays} bank hols ={" "}
                {inp.annualLeaveDays + inp.studyLeaveDays + inp.bankHolidayDays}{" "}
                days = {calc.leaveWeeks.toFixed(2)} weeks
              </li>
              <li>
                Working weeks/year = {inp.weeksPerYear} −{" "}
                {calc.leaveWeeks.toFixed(2)} ={" "}
                <strong>{calc.workingWeeks.toFixed(2)}</strong>
              </li>
              <li>
                Per consultant: {inp.dccPasPerConsultant} DCC PAs ×{" "}
                {inp.sessionsPerPa} session/PA ={" "}
                {calc.weeklyClinicalSessions} sessions/wk ×{" "}
                {calc.workingWeeks.toFixed(2)} wks × (1 −{" "}
                {inp.sicknessRatePct}% sickness) ={" "}
                <strong>{calc.annualSessionsPerConsultant.toFixed(1)}</strong>{" "}
                sessions/yr
              </li>
              <li>
                FTE needed = {Math.round(calc.annualDemand).toLocaleString()} ÷{" "}
                {calc.annualSessionsPerConsultant.toFixed(1)} ={" "}
                <strong>{calc.fteNeeded.toFixed(2)}</strong>
              </li>
            </ul>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Capacity breakdown</CardTitle>
          <CardDescription>
            How leave, sickness and on-call cover chip away at a consultant&apos;s
            effective annual list-running capacity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Per consultant */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Per consultant (all consultants)
            </div>
            <div className="space-y-1 text-sm">
              <CapacityRow
                label="Gross potential (no leave, no sickness)"
                value={calc.grossAnnualSessionsPerConsultant}
                suffix="sessions/yr"
                muted
              />
              <CapacityRow
                label={`Less leave (${calc.leaveWeeks.toFixed(1)} wks)`}
                value={-calc.leaveLostAnnualSessionsPerConsultant}
                suffix="sessions/yr"
                accent="text-muted-foreground"
              />
              <CapacityRow
                label="After leave"
                value={calc.afterLeaveAnnualSessionsPerConsultant}
                suffix="sessions/yr"
                strong
              />
              <CapacityRow
                label={`Less sickness (${inp.sicknessRatePct}%)`}
                value={-calc.sicknessLostAnnualSessionsPerConsultant}
                suffix="sessions/yr"
                accent="text-muted-foreground"
              />
              <CapacityRow
                label="Net clinical capacity"
                value={calc.annualSessionsPerConsultant}
                suffix="sessions/yr"
                strong
              />
              <CapacityRow
                label={`Less on-call share (${calc.annualOnCallBurdenPerConsultant.toFixed(1)} sess/yr)`}
                value={-calc.annualOnCallBurdenPerConsultant}
                suffix="sessions/yr"
                accent="text-muted-foreground"
              />
              <div className="mt-2 border-t pt-2">
                <CapacityRow
                  label="Effective for list running"
                  value={calc.residualListCapacityPerConsultant}
                  suffix="sessions/yr"
                  strong
                  highlight
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Per ICU-trained consultant */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Per ICU-trained consultant
            </div>
            <div className="space-y-1 text-sm">
              <CapacityRow
                label="Gross potential"
                value={calc.grossAnnualSessionsPerConsultant}
                suffix="sessions/yr"
                muted
              />
              <CapacityRow
                label={`Less leave (${calc.leaveWeeks.toFixed(1)} wks)`}
                value={-calc.leaveLostAnnualSessionsPerConsultant}
                suffix="sessions/yr"
                accent="text-muted-foreground"
              />
              <CapacityRow
                label="After leave & sickness"
                value={calc.annualSessionsPerConsultant}
                suffix="sessions/yr"
                strong
              />
              <CapacityRow
                label={`ICU demand share (lists + OOH)`}
                value={-calc.icuDemandPerConsultant}
                suffix="sessions/yr"
                accent="text-muted-foreground"
              />
              <div className="mt-2 border-t pt-2">
                <CapacityRow
                  label="Effective for non-ICU work"
                  value={calc.icuResidualCapacityPerConsultant}
                  suffix="sessions/yr"
                  strong
                  highlight
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Demand contributions: per-stream FTE impact */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Demand contributions (FTE per session/week)
            </div>
            <p className="text-xs text-muted-foreground">
              Each row shows how many sessions/week that service consumes,
              the annual session-equivalents it generates, and the FTE impact
              of a single weekly session at the current capacity assumptions
              (1 sess/wk = {inp.weeksPerYear} ÷{" "}
              {calc.annualSessionsPerConsultant.toFixed(1)} ={" "}
              <strong>
                {(calc.annualSessionsPerConsultant > 0
                  ? inp.weeksPerYear / calc.annualSessionsPerConsultant
                  : 0
                ).toFixed(3)}
              </strong>{" "}
              FTE).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Service</th>
                    <th className="py-1 px-2 text-right font-medium">Sess/wk</th>
                    <th className="py-1 px-2 text-right font-medium">Sess/yr</th>
                    <th className="py-1 pl-2 text-right font-medium">FTE</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: "Theatres", weekly: calc.theatreSessions },
                    { label: "Labour ward", weekly: inp.labourWardSessionsPerWeek },
                    { label: "Consultant in charge", weekly: inp.consultantInChargeSessionsPerWeek },
                    { label: "Pain service", weekly: inp.painServiceSessionsPerWeek },
                    { label: "POAC", weekly: inp.poacSessionsPerWeek },
                    {
                      label: "Non-clinical PAs",
                      weekly: inp.nonClinicalPAsPerWeek * inp.sessionsPerPa,
                    },
                    { label: "ICU (lists)", weekly: inp.icuSessionsPerWeek },
                    {
                      label: "On-call (theatre + ICU)",
                      weekly: calc.weeklyOnCallPAs * inp.sessionsPerPa,
                    },
                  ].map((row) => {
                    const annual = row.weekly * inp.weeksPerYear;
                    const fte =
                      calc.annualSessionsPerConsultant > 0
                        ? annual / calc.annualSessionsPerConsultant
                        : 0;
                    return (
                      <tr key={row.label} className="border-b last:border-0">
                        <td className="py-1 pr-2">{row.label}</td>
                        <td className="py-1 px-2 text-right tabular-nums">
                          {row.weekly.toFixed(1)}
                        </td>
                        <td className="py-1 px-2 text-right tabular-nums">
                          {Math.round(annual).toLocaleString()}
                        </td>
                        <td className="py-1 pl-2 text-right tabular-nums">
                          {fte.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="font-semibold">
                    <td className="py-1 pr-2">Total</td>
                    <td className="py-1 px-2 text-right tabular-nums">
                      {calc.weeklyDemand.toFixed(1)}
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums">
                      {Math.round(calc.annualDemand).toLocaleString()}
                    </td>
                    <td className="py-1 pl-2 text-right tabular-nums text-primary">
                      {calc.fteNeeded.toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
      </>)}
    </div>
  );
}

function Field({
  label, value, onChange, step, hint, error,
}: {
  label: string;
  value: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  step?: string;
  hint?: string;
  error?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step={step ?? "1"}
        min={0}
        value={value}
        onChange={onChange}
        aria-invalid={!!error}
        className={
          "h-9 " +
          (error ? "border-destructive focus-visible:ring-destructive" : "")
        }
      />
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}


function Stat({
  label, value, sub,
}: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && (
        <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

function CapacityRow({
  label,
  value,
  suffix,
  strong,
  highlight,
  muted,
  accent,
}: {
  label: string;
  value: number;
  suffix?: string;
  strong?: boolean;
  highlight?: boolean;
  muted?: boolean;
  accent?: string;
}) {
  const isNegative = value < 0;
  const displayValue = Math.abs(value).toFixed(1);
  const valueClass = highlight
    ? "text-primary font-semibold"
    : strong
      ? "font-semibold"
      : muted
        ? "text-muted-foreground"
        : accent
          ? accent
          : "";

  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={muted ? "text-muted-foreground" : accent ? accent : ""}>
        {label}
      </span>
      <span className={valueClass}>
        {isNegative ? "−" : ""}
        {displayValue}
        {suffix ? ` ${suffix}` : ""}
      </span>
    </div>
  );
}
