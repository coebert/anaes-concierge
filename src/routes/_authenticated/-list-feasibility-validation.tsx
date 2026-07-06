import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  computeListFeasibility,
  DOW_LABEL,
  type FeasibilityThresholds,
} from "@/features/audit/list-feasibility";
import {
  validateConsultantPatterns,
  type SampleClassification,
} from "@/features/audit/list-feasibility-validation";
import {
  diagnoseValidationReport,
  type DiagnosedReport,
  type DiagnosedConsultant,
  type DiagnosedCell,
  type Diagnosis,
  type Remediation,
} from "@/features/audit/list-feasibility-diagnosis";

interface RemediationActions {
  onApply: (r: Remediation) => void;
  isApplying: boolean;
  isApplicable: (kind: Remediation["kind"]) => boolean;
}

export function ValidationCard({
  monthsBack,
  thresholds,
}: {
  monthsBack: number;
  thresholds: FeasibilityThresholds;
}) {
  const [enabled, setEnabled] = useState(false);
  const [sampleCap, setSampleCap] = useState(10);
  const [mismatchThreshold, setMismatchThreshold] = useState(15);
  const [onlyMismatches, setOnlyMismatches] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [monthsBackOverride, setMonthsBackOverride] = useState<number | null>(null);
  const [verification, setVerification] = useState<{
    at: string;
    tokenCount: number;
    tokensSample: string[];
    feasible: number;
    borderline: number;
    notFeasible: number;
    monthsBack: number;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const effectiveMonthsBack = monthsBackOverride ?? monthsBack;
  const queryClient = useQueryClient();

  // Explicit post-remediation verification: re-read the updated tokens from
  // the DB and re-run computeListFeasibility with them, so we can confirm
  // the recomputed model numbers BEFORE the validation report re-renders.
  const runVerification = async (forMonthsBack: number) => {
    setVerifying(true);
    try {
      const { data: rows, error } = await supabase
        .from("validation_custom_non_working_labels")
        .select("token")
        .order("token", { ascending: true });
      if (error) throw new Error(error.message);
      const tokens = (rows ?? [])
        .map((r) => (r as { token: string }).token)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      const model = await computeListFeasibility({
        monthsBack: forMonthsBack,
        thresholds,
        extraNonWorkingTokens: tokens,
      });
      setVerification({
        at: new Date().toISOString(),
        tokenCount: tokens.length,
        tokensSample: tokens.slice(0, 8),
        feasible: model.summary.feasible,
        borderline: model.summary.borderline,
        notFeasible: model.summary.notFeasible,
        monthsBack: forMonthsBack,
      });
    } finally {
      setVerifying(false);
    }
  };

  const queryKey = [
    "list-feasibility-validation",
    effectiveMonthsBack,
    sampleCap,
    mismatchThreshold,
    JSON.stringify(thresholds),
  ] as const;

  const { data, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const raw = await validateConsultantPatterns({
        monthsBack: effectiveMonthsBack,
        thresholds,
        sampleCap,
        mismatchThresholdPct: mismatchThreshold,
      });
      return diagnoseValidationReport(raw);
    },
    enabled,
  });

  const run = () => {
    if (enabled) {
      void refetch();
    } else {
      setEnabled(true);
    }
  };

  // ---- Apply remediation -> auto re-run validation ----
  const applyMutation = useMutation({
    mutationFn: async (remediation: Remediation) => {
      switch (remediation.kind) {
        case "extend-non-working-labels": {
          const tokens = ((remediation.payload?.tokens as string[]) ?? [])
            .map((t) => t.trim())
            .filter(Boolean);
          if (tokens.length === 0) throw new Error("No tokens to add");
          const rows = tokens.map((token) => ({
            token,
            source: "auto-remediation:list-feasibility",
          }));
          const { error } = await supabase
            .from("validation_custom_non_working_labels")
            .upsert(rows, { onConflict: "token", ignoreDuplicates: true });
          if (error) throw new Error(error.message);
          return {
            message: `Added ${tokens.length} label${tokens.length === 1 ? "" : "s"} to the non-working list.`,
          };
        }
        case "widen-validation-window": {
          const next = Math.min(24, effectiveMonthsBack + 3);
          if (next === effectiveMonthsBack) {
            throw new Error("Validation window is already at the maximum (24 months).");
          }
          setMonthsBackOverride(next);
          return { message: `Widened validation window to ${next} months.` };
        }
        default:
          throw new Error("This remediation has no in-app apply action.");
      }
    },
    onSuccess: async (result) => {
      toast.success(result.message, {
        description: "Verifying updated tokens and re-running validation…",
      });
      // Make sure the next run reflects newly inserted DB rows.
      await queryClient.invalidateQueries({ queryKey: ["list-feasibility-validation"] });
      // Explicit verification step: re-read tokens from DB and recompute the
      // model before re-rendering the validation report.
      try {
        await runVerification(effectiveMonthsBack);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `Verification failed: ${err.message}`
            : "Verification failed",
        );
      }
      await refetch();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not apply remediation");
    },
  });

  const isApplicable = (kind: Remediation["kind"]) =>
    kind === "extend-non-working-labels" || kind === "widen-validation-window";

  // ---- Apply ALL eligible remediations in the current report ----
  const eligibleRemediations: Remediation[] = data
    ? data.consultants.flatMap((c) =>
        c.cells.flatMap((cell) =>
          cell.diagnoses
            .map((d) => d.remediation)
            .filter((r) => isApplicable(r.kind)),
        ),
      )
    : [];

  const aggregateTokens = Array.from(
    new Set(
      eligibleRemediations
        .filter((r) => r.kind === "extend-non-working-labels")
        .flatMap((r) => ((r.payload?.tokens as string[]) ?? []).map((t) => t.trim()))
        .filter(Boolean),
    ),
  );
  const wantsWiden = eligibleRemediations.some(
    (r) => r.kind === "widen-validation-window",
  );
  const canWiden = wantsWiden && effectiveMonthsBack < 24;
  const totalEligibleFixes = aggregateTokens.length + (canWiden ? 1 : 0);

  const applyAllMutation = useMutation({
    mutationFn: async () => {
      const steps: string[] = [];
      if (aggregateTokens.length > 0) {
        const rows = aggregateTokens.map((token) => ({
          token,
          source: "auto-remediation:list-feasibility:apply-all",
        }));
        const { error } = await supabase
          .from("validation_custom_non_working_labels")
          .upsert(rows, { onConflict: "token", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
        steps.push(
          `Added ${aggregateTokens.length} label${aggregateTokens.length === 1 ? "" : "s"} to the non-working list`,
        );
      }
      if (canWiden) {
        const next = Math.min(24, effectiveMonthsBack + 3);
        setMonthsBackOverride(next);
        steps.push(`Widened validation window to ${next} months`);
      }
      if (steps.length === 0) {
        throw new Error("No eligible remediations to apply.");
      }
      return { message: steps.join("; ") + "." };
    },
    onSuccess: async (result) => {
      toast.success("Applied all eligible fixes", {
        description: `${result.message} Verifying updated tokens and re-running validation…`,
      });
      await queryClient.invalidateQueries({ queryKey: ["list-feasibility-validation"] });
      const nextMonths = canWiden
        ? Math.min(24, effectiveMonthsBack + 3)
        : effectiveMonthsBack;
      try {
        await runVerification(nextMonths);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `Verification failed: ${err.message}`
            : "Verification failed",
        );
      }
      await refetch();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not apply fixes");
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Working-pattern validation</CardTitle>
        <CardDescription>
          One-click sanity check: for each consultant × (day-of-week,
          session) cell, this pulls a sample of actual rota_assignments
          rows from the same window and recomputes a sampled working %
          independently of the model. Cells whose sampled % differs from
          the model by more than the mismatch threshold are flagged, and
          each flagged cell shows an auto-investigation diagnosis with a
          one-click apply button where the fix can be made in-app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Sample size per cell</Label>
            <Input
              type="number"
              className="w-24"
              min={3}
              max={50}
              value={sampleCap}
              onChange={(e) =>
                setSampleCap(Math.max(3, Number(e.target.value) || 10))
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Mismatch threshold (% pts)</Label>
            <Input
              type="number"
              className="w-24"
              min={5}
              max={50}
              step={5}
              value={mismatchThreshold}
              onChange={(e) =>
                setMismatchThreshold(Math.max(5, Number(e.target.value) || 15))
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Validation window (months)</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                className="w-24"
                min={1}
                max={24}
                value={effectiveMonthsBack}
                onChange={(e) =>
                  setMonthsBackOverride(
                    Math.min(24, Math.max(1, Number(e.target.value) || monthsBack)),
                  )
                }
              />
              {monthsBackOverride !== null && monthsBackOverride !== monthsBack && (
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground underline"
                  onClick={() => setMonthsBackOverride(null)}
                >
                  reset
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="only-mismatches"
              checked={onlyMismatches}
              onCheckedChange={setOnlyMismatches}
            />
            <Label htmlFor="only-mismatches" className="text-xs">
              Only show consultants with mismatches
            </Label>
          </div>
          <Button size="sm" onClick={run} disabled={isFetching}>
            {isFetching
              ? "Validating…"
              : enabled
                ? "Re-run validation"
                : "Run validation"}
          </Button>
          {enabled && data && totalEligibleFixes > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => applyAllMutation.mutate()}
              disabled={
                applyAllMutation.isPending || applyMutation.isPending || isFetching
              }
            >
              {applyAllMutation.isPending
                ? "Applying all fixes…"
                : `Apply all fixes & re-run (${totalEligibleFixes})`}
            </Button>
          )}
        </div>

        {(verifying || verification) && (
          <div className="rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-200">
            {verifying ? (
              <span>
                <strong>Verifying…</strong> re-reading non-working labels from
                the database and recomputing the feasibility model before
                refreshing the validation report.
              </span>
            ) : verification ? (
              <div className="space-y-1">
                <div>
                  <strong>Verification complete</strong> — recomputed model
                  with{" "}
                  <span className="font-mono">{verification.tokenCount}</span>{" "}
                  non-working label token(s) over a{" "}
                  <span className="font-mono">{verification.monthsBack}</span>
                  -month window at{" "}
                  {new Date(verification.at).toLocaleTimeString()}.
                </div>
                <div className="text-[11px]">
                  Recomputed list verdicts: feasible{" "}
                  <span className="font-mono">{verification.feasible}</span>,
                  borderline{" "}
                  <span className="font-mono">{verification.borderline}</span>,
                  not feasible{" "}
                  <span className="font-mono">{verification.notFeasible}</span>.
                  {verification.tokensSample.length > 0 && (
                    <>
                      {" "}Tokens in effect:{" "}
                      <span className="font-mono">
                        {verification.tokensSample.join(", ")}
                        {verification.tokenCount > verification.tokensSample.length
                          ? ` … (+${verification.tokenCount - verification.tokensSample.length} more)`
                          : ""}
                      </span>
                      .
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {!enabled ? (
          <p className="text-xs text-muted-foreground">
            Validation hasn't been run yet. Press <strong>Run validation</strong> to
            independently re-derive consultant working patterns from raw
            CLWRota records.
          </p>
        ) : isFetching && !data ? (
          <p className="text-sm text-muted-foreground">Sampling raw rota records…</p>
        ) : !data ? null : (
          <ValidationResults
            report={data}
            onlyMismatches={onlyMismatches}
            expanded={expanded}
            setExpanded={setExpanded}
            onApply={(r) => applyMutation.mutate(r)}
            isApplying={applyMutation.isPending}
            isApplicable={isApplicable}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ValidationResults({
  report,
  onlyMismatches,
  expanded,
  setExpanded,
  onApply,
  isApplying,
  isApplicable,
}: {
  report: DiagnosedReport;
  onlyMismatches: boolean;
  expanded: string | null;
  setExpanded: (k: string | null) => void;
} & RemediationActions) {
  const consultants = onlyMismatches
    ? report.consultants.filter((c) => c.mismatchCount > 0)
    : report.consultants;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4 text-xs">
        <SummaryPill
          label="Consultants checked"
          value={report.consultants.length}
        />
        <SummaryPill
          label="Cells checked"
          value={report.totalCells}
        />
        <SummaryPill
          label="Cells flagged"
          value={report.cellsWithMismatch}
          tone={report.cellsWithMismatch > 0 ? "red" : "emerald"}
        />
        <SummaryPill
          label="Consultants flagged"
          value={report.consultantsWithMismatch}
          tone={report.consultantsWithMismatch > 0 ? "red" : "emerald"}
        />
      </div>

      {report.causeTally.length > 0 && (
        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <div className="text-xs font-medium">
            Auto-investigation: most common causes
          </div>
          <ul className="text-xs space-y-1">
            {report.causeTally.map((c) => (
              <li key={c.code} className="flex items-center gap-2">
                <Badge variant="secondary" className="tabular-nums">
                  {c.count}
                </Badge>
                <span>{c.summary}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Expand any flagged consultant below to see per-cell diagnoses and
            recommended fixes.
          </p>
        </div>
      )}

      {consultants.length === 0 ? (
        <p className="text-xs text-success">
          No mismatches detected at the current threshold (±{report.mismatchThresholdPct}{" "}
          percentage points). All sampled cells agree with the model.
        </p>
      ) : (
        <div className="space-y-2">
          {consultants.map((c) => (
            <ValidationConsultantRow
              key={c.id}
              consultant={c}
              expanded={expanded === c.id}
              onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
              onApply={onApply}
              isApplying={isApplying}
              isApplicable={isApplicable}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ValidationConsultantRow({
  consultant,
  expanded,
  onToggle,
  onApply,
  isApplying,
  isApplicable,
}: {
  consultant: DiagnosedConsultant;
  expanded: boolean;
  onToggle: () => void;
} & RemediationActions) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/40"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-sm">{consultant.name}</span>
          {consultant.mismatchCount > 0 ? (
            <Badge className="bg-red-100 text-red-700 hover:bg-red-100">
              {consultant.mismatchCount} mismatch
              {consultant.mismatchCount === 1 ? "" : "es"}
            </Badge>
          ) : (
            <Badge className="bg-success-muted text-success hover:bg-success-muted">
              Agrees with model
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">
            max Δ {consultant.maxAbsDelta} pts
          </span>
          {consultant.topDiagnosis && (
            <span className="text-[11px] text-muted-foreground italic truncate max-w-[40ch]">
              · {consultant.topDiagnosis.summary}
            </span>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {consultant.tenureStart && consultant.tenureEnd
            ? `${consultant.tenureStart} → ${consultant.tenureEnd}`
            : "no tenure data"}
        </span>
      </button>
      {expanded && (
        <div className="border-t bg-muted/20 p-3 space-y-3">
          <ValidationCellTable
            cells={consultant.cells}
            onApply={onApply}
            isApplying={isApplying}
            isApplicable={isApplicable}
          />
        </div>
      )}
    </div>
  );
}

function ValidationCellTable({
  cells,
  onApply,
  isApplying,
  isApplicable,
}: { cells: DiagnosedCell[] } & RemediationActions) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Cell</th>
            <th className="px-2 py-1 text-center font-medium">Model %</th>
            <th className="px-2 py-1 text-center font-medium">Sampled %</th>
            <th className="px-2 py-1 text-center font-medium">Δ</th>
            <th className="px-2 py-1 text-center font-medium">n</th>
            <th className="px-2 py-1 text-center font-medium">Clin</th>
            <th className="px-2 py-1 text-center font-medium">Off-lbl</th>
            <th className="px-2 py-1 text-center font-medium">Other</th>
            <th className="px-2 py-1 text-center font-medium">None</th>
            <th className="px-2 py-1 text-left font-medium">Sampled dates</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <Fragment key={`${cell.dow}-${cell.session}`}>
              <tr
                className={cn(
                  "border-t align-top",
                  cell.mismatch && "bg-red-50 dark:bg-red-950/20",
                )}
              >
                <td className="px-2 py-1.5 whitespace-nowrap font-medium">
                  {DOW_LABEL[cell.dow]}{" "}
                  <span className="uppercase text-muted-foreground">
                    {cell.session}
                  </span>
                  {cell.modelRegularDayOff && (
                    <span className="ml-1 text-[10px] italic text-muted-foreground">
                      (off)
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center font-mono">
                  {cell.modelPct}%
                </td>
                <td className="px-2 py-1.5 text-center font-mono">
                  {cell.sampleSize === 0 ? "—" : `${cell.sampledPct}%`}
                </td>
                <td
                  className={cn(
                    "px-2 py-1.5 text-center font-mono",
                    cell.mismatch && "text-red-700 font-semibold",
                  )}
                >
                  {cell.sampleSize === 0 ? "—" : `${cell.delta > 0 ? "+" : ""}${cell.delta}`}
                </td>
                <td className="px-2 py-1.5 text-center text-muted-foreground">
                  {cell.sampleSize}/{cell.tenureDates}
                </td>
                <td className="px-2 py-1.5 text-center">{cell.clinical}</td>
                <td className="px-2 py-1.5 text-center">{cell.offDayLabel}</td>
                <td className="px-2 py-1.5 text-center">{cell.otherDuty}</td>
                <td className="px-2 py-1.5 text-center">{cell.noRecord}</td>
                <td className="px-2 py-1.5">
                  <ul className="space-y-0.5">
                    {cell.samples.map((s) => (
                      <li key={s.date} className="text-[10px] leading-tight">
                        <span className="font-mono">{s.date}</span>{" "}
                        <ClassificationBadge classification={s.classification} />
                        {s.dutyType && (
                          <span className="ml-1 text-muted-foreground">
                            {s.dutyType}
                            {s.roleOnList ? `/${s.roleOnList}` : ""}
                          </span>
                        )}
                        {s.notes && (
                          <span className="ml-1 text-muted-foreground italic">
                            "{s.notes.slice(0, 60)}
                            {s.notes.length > 60 ? "…" : ""}"
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
              {cell.diagnoses.length > 0 && (
                <tr className="border-t-0 bg-amber-50/50 dark:bg-amber-950/10">
                  <td colSpan={10} className="px-2 pb-2">
                    <DiagnosisList
                      diagnoses={cell.diagnoses}
                      onApply={onApply}
                      isApplying={isApplying}
                      isApplicable={isApplicable}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiagnosisList({
  diagnoses,
  onApply,
  isApplying,
  isApplicable,
}: { diagnoses: Diagnosis[] } & RemediationActions) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Auto-investigation
      </div>
      <ul className="space-y-1.5">
        {diagnoses.map((d, i) => (
          <li
            key={`${d.code}-${i}`}
            className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] dark:border-amber-900 dark:bg-amber-950/30"
          >
            <div className="flex items-start gap-2">
              <Badge
                className={cn(
                  "shrink-0 text-[9px] uppercase",
                  d.severity === "error" && "bg-red-100 text-red-800",
                  d.severity === "warn" && "bg-amber-100 text-amber-800",
                  d.severity === "info" && "bg-slate-100 text-slate-700",
                )}
              >
                {d.severity}
              </Badge>
              <div className="space-y-0.5 flex-1">
                <div className="font-medium">{d.summary}</div>
                {d.evidence.length > 0 && (
                  <ul className="list-disc pl-4 text-muted-foreground">
                    {d.evidence.map((e, j) => (
                      <li key={j}>{e}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <span className="text-muted-foreground">
                    → {d.remediation.summary}
                  </span>
                  {isApplicable(d.remediation.kind) && (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-6 px-2 text-[10px]"
                      disabled={isApplying}
                      onClick={() => onApply(d.remediation)}
                    >
                      {isApplying ? "Applying…" : "Apply fix & re-run"}
                    </Button>
                  )}
                  {d.remediation.href && (
                    <Link
                      to={d.remediation.href}
                      className="text-primary underline underline-offset-2"
                    >
                      Open
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClassificationBadge({
  classification,
}: {
  classification: SampleClassification;
}) {
  const map: Record<SampleClassification, { label: string; cls: string }> = {
    clinical: { label: "clin", cls: "bg-emerald-100 text-emerald-800" },
    off_day_label: { label: "off-lbl", cls: "bg-slate-200 text-slate-700" },
    other_duty: { label: "other", cls: "bg-amber-100 text-amber-800" },
    no_record: { label: "none", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[classification];
  return (
    <span
      className={cn(
        "inline-block rounded px-1 text-[9px] font-medium uppercase tracking-wide",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "red";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        tone === "red" && "border-red-300 bg-red-50 text-red-900",
        tone === "emerald" && "border-emerald-300 bg-emerald-50 text-emerald-900",
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
