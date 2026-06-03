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
};

function ConsultantFeasibilityPage() {
  const [inp, setInp] = useState<Inputs>(DEFAULTS);

  const calc = useMemo(() => {
    const theatreSessions =
      (inp.mainTheatres + inp.daySurgeryTheatres) *
      inp.sessionsPerTheatrePerWeek;
    const weeklyDemand =
      theatreSessions +
      inp.labourWardSessionsPerWeek +
      inp.icuSessionsPerWeek;
    const annualDemand = weeklyDemand * inp.weeksPerYear;

    const leaveDays =
      inp.annualLeaveDays + inp.studyLeaveDays + inp.bankHolidayDays;
    const leaveWeeks = leaveDays / inp.workingDaysPerWeek;
    const workingWeeks = Math.max(0, inp.weeksPerYear - leaveWeeks);

    const weeklyClinicalSessions =
      inp.dccPasPerConsultant * inp.sessionsPerPa;
    const annualSessionsPerConsultant = weeklyClinicalSessions * workingWeeks;

    const fteNeeded = annualDemand / annualSessionsPerConsultant;

    // ICU subgroup feasibility: 10 sessions/week × 52 = annual ICU demand,
    // must be covered by the 10-strong ICU-trained pool's annual capacity.
    const icuAnnualDemand = inp.icuSessionsPerWeek * inp.weeksPerYear;
    const icuPoolAnnualCapacity =
      inp.icuTrainedPoolSize * annualSessionsPerConsultant;
    const icuPoolUtilisation =
      icuPoolAnnualCapacity > 0
        ? icuAnnualDemand / icuPoolAnnualCapacity
        : Infinity;
    // Each ICU-trained consultant must spend this fraction of their clinical
    // time on ICU; the remainder is available for theatre / labour ward.
    const icuSharePerConsultant =
      inp.icuTrainedPoolSize > 0
        ? inp.icuSessionsPerWeek / inp.icuTrainedPoolSize / weeklyClinicalSessions
        : Infinity;

    return {
      theatreSessions,
      weeklyDemand,
      annualDemand,
      leaveWeeks,
      workingWeeks,
      weeklyClinicalSessions,
      annualSessionsPerConsultant,
      fteNeeded,
      icuAnnualDemand,
      icuPoolAnnualCapacity,
      icuPoolUtilisation,
      icuSharePerConsultant,
    };
  }, [inp]);

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
              <strong className="text-foreground">Demand</strong> = (main + day-surgery theatres) × sessions/theatre/week + labour-ward sessions/week + ICU sessions/week.
            </li>
            <li>
              <strong className="text-foreground">A "session"</strong> is a half-day list (AM or PM). Mon–Fri AM+PM = 10 sessions/theatre/week.
            </li>
            <li>
              <strong className="text-foreground">Per-consultant capacity</strong>: only DCC PAs count toward clinical sessions (SPA time excluded). Sessions/week = DCC PAs × sessions per PA.
            </li>
            <li>
              <strong className="text-foreground">Leave treatment</strong>: annual + study + bank-holiday days are summed and divided by working-days/week to convert into weeks lost. Working weeks/year = weeks/year − leave weeks.
            </li>
            <li>
              <strong className="text-foreground">FTE needed</strong> = annual demand ÷ (weekly clinical sessions × working weeks/year). Headcount is the FTE rounded up.
            </li>
            <li>
              <strong className="text-foreground">ICU subgroup check</strong>: ICU sessions can only be drawn from the ICU-trained pool. Pool utilisation = ICU annual demand ÷ (pool size × per-consultant annual capacity). Must be ≤ 100% to be feasible.
            </li>
            <li>
              <strong className="text-foreground">Not modelled</strong>: sickness, on-call/night cover, parental leave, fixed sessions, LTFT, weekend lists, cross-cover for absences.
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
          </CardContent>
        </Card>
      </div>



      {!hasErrors && (
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
              label="Weekly clinical sessions to cover"
              value={calc.weeklyDemand.toLocaleString()}
              sub={`${calc.theatreSessions} theatre + ${inp.labourWardSessionsPerWeek} labour ward + ${inp.icuSessionsPerWeek} ICU`}
            />
            <Stat
              label="Annual clinical sessions"
              value={Math.round(calc.annualDemand).toLocaleString()}
              sub={`${calc.weeklyDemand} × ${inp.weeksPerYear} weeks`}
            />
            <Stat
              label="Sessions / consultant / year"
              value={calc.annualSessionsPerConsultant.toFixed(1)}
              sub={`${calc.weeklyClinicalSessions} cln sessions × ${calc.workingWeeks.toFixed(1)} working wks`}
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
                  {inp.icuSessionsPerWeek} ICU sessions/week must be drawn from
                  the {inp.icuTrainedPoolSize}-strong ICU-trained pool. Each
                  ICU-trained consultant would spend{" "}
                  <strong>
                    {(calc.icuSharePerConsultant * 100).toFixed(1)}%
                  </strong>{" "}
                  of their clinical time on ICU, leaving the remainder for
                  theatres / labour ward.
                </p>
                <p className="text-muted-foreground">
                  Annual ICU demand{" "}
                  {Math.round(calc.icuAnnualDemand).toLocaleString()} vs pool
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
                Weekly demand = {calc.theatreSessions} theatre +{" "}
                {inp.labourWardSessionsPerWeek} labour ward +{" "}
                {inp.icuSessionsPerWeek} ICU ={" "}
                <strong>{calc.weeklyDemand}</strong>
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
                {calc.workingWeeks.toFixed(2)} wks ={" "}
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
