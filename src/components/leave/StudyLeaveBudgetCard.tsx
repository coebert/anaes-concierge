import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { AlertTriangle, GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudyBudget } from "@/features/leave/study-leave-budget";

const gbp = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

function pct(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/**
 * Displays remaining study-leave days and £ for a staff member alongside
 * a leave-approval decision. Shows a warning if the pending decision would
 * push either figure negative.
 *
 * `preview` is the budget position AFTER the current request is approved.
 * `base` is the position BEFORE, i.e. excluding the current request.
 */
export function StudyLeaveBudgetCard({
  base,
  preview,
  requestDays,
  requestCostGbp,
  className,
}: {
  base: StudyBudget;
  preview: StudyBudget;
  requestDays: number;
  requestCostGbp: number;
  className?: string;
}) {
  const overDays = preview.daysRemaining < 0;
  const overBudget = preview.remainingGbp < 0;
  const noBudget = base.budgetGbp === 0 && base.daysAllowance === 0;

  return (
    <Card className={cn("bg-muted/40", className)}>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GraduationCap className="h-4 w-4 text-muted-foreground" />
          Study-leave budget
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            Year from {base.yearStartISO}
          </span>
        </div>

        {noBudget && (
          <p className="text-xs text-muted-foreground">
            No study-leave allowance recorded for this staff member. Set one in
            Leave → Allowances.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <BudgetRow
            label="Days"
            allowance={base.daysAllowance}
            taken={base.daysTaken}
            pending={base.daysPending}
            requestAmount={requestDays}
            remainingBase={base.daysRemaining}
            remainingAfter={preview.daysRemaining}
            over={overDays}
            format={(n) => n.toFixed(n % 1 === 0 ? 0 : 1)}
          />
          <BudgetRow
            label="Budget (£)"
            allowance={base.budgetGbp}
            taken={base.spentGbp}
            pending={base.pendingGbp}
            requestAmount={requestCostGbp}
            remainingBase={base.remainingGbp}
            remainingAfter={preview.remainingGbp}
            over={overBudget}
            format={(n) => gbp.format(n)}
          />
        </div>

        {(overDays || overBudget) && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>
              Approving this request would exceed the
              {overDays && overBudget ? " days AND £ " : overDays ? " days " : " £ "}
              allowance for this leave year.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BudgetRow({
  label,
  allowance,
  taken,
  pending,
  requestAmount,
  remainingBase,
  remainingAfter,
  over,
  format,
}: {
  label: string;
  allowance: number;
  taken: number;
  pending: number;
  requestAmount: number;
  remainingBase: number;
  remainingAfter: number;
  over: boolean;
  format: (n: number) => string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span
          className={cn(
            "text-sm font-semibold tabular-nums",
            over && "text-destructive",
          )}
          aria-label={`${format(remainingAfter)} remaining after this decision`}
        >
          {format(remainingAfter)} left
        </span>
      </div>
      <Progress
        value={pct(taken, allowance)}
        className={cn("h-2", over && "[&>div]:bg-destructive")}
      />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <dt>Allowance</dt><dd className="tabular-nums text-foreground/80">{format(allowance)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Taken</dt><dd className="tabular-nums text-foreground/80">{format(taken)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Pending</dt><dd className="tabular-nums text-foreground/80">{format(pending)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>This request</dt>
          <dd className={cn("tabular-nums", requestAmount > remainingBase ? "text-destructive" : "text-foreground/80")}>
            {format(requestAmount)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
