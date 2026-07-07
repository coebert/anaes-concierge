import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  computeCompetencyMismatch,
  STATUS_LABEL,
  type MismatchStatus,
} from "@/features/competencies/mismatch";
import type {
  Competency, CompetencyRequirement, StaffCompetency,
} from "@/features/competencies/competencies";

/**
 * Small clickable/hoverable info icon that expands into a table of the
 * required competencies for this pairing, showing which are OK, expiring,
 * missing, expired, revoked, or supervised-only.
 */
export function CompetencyMismatchTooltip({
  staffId, staffName, specialtyId, specialtyName, role, onDate,
  competencies, requirements, staffCompetencies,
}: {
  staffId: string;
  staffName?: string;
  specialtyId: string;
  specialtyName?: string;
  role: string;
  onDate: string;
  competencies: Competency[];
  requirements: CompetencyRequirement[];
  staffCompetencies: StaffCompetency[];
}) {
  const details = computeCompetencyMismatch({
    staffId, specialtyId, role, onDate,
    competencies, requirements, staffCompetencies,
  });

  if (details.rows.length === 0) return null;

  const total = details.rows.filter((r) => r.requirement === "required").length;
  const heldOk = details.requiredHeld;

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-0.5 rounded-sm p-0.5 hover:bg-muted focus:outline-none focus:ring-1",
              details.hasBlocker ? "text-destructive" : "text-muted-foreground",
            )}
            aria-label="Competency details"
          >
            <Info className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-md p-3 space-y-2" side="right">
          <div className="text-xs font-medium">
            Competency check
            {staffName && specialtyName && (
              <span className="font-normal text-muted-foreground">
                {" "}— {staffName} · {specialtyName} · {role}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {heldOk} / {total} required competencies met
            {details.requiredMissing > 0 && (
              <span className="text-destructive font-medium">
                {" · "}{details.requiredMissing} missing
              </span>
            )}
          </div>
          <div className="rounded border divide-y">
            {details.rows.map((r) => (
              <div key={r.competencyId} className="grid grid-cols-[1fr_auto] gap-2 p-1.5 text-[11px]">
                <div className="min-w-0">
                  <div className="truncate">
                    <span className={r.blocking ? "font-semibold" : ""}>
                      {r.competencyName}
                    </span>
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      {r.competencyCode}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {r.requirement === "required" ? "Required" : "Recommended"}
                    {r.expiresAt && (
                      <span> · expires {r.expiresAt}
                        {r.daysUntilExpiry !== null && r.daysUntilExpiry >= 0 && r.daysUntilExpiry <= 60 &&
                          ` (${r.daysUntilExpiry}d)`}
                      </span>
                    )}
                  </div>
                </div>
                <StatusPill status={r.status} blocking={r.blocking} />
              </div>
            ))}
          </div>
          {details.hasBlocker && (
            <div className="text-[10px] text-destructive">
              Assignment will be blocked until the missing sign-offs are recorded.
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function StatusPill({ status, blocking }: { status: MismatchStatus; blocking: boolean }) {
  const cls = blocking
    ? "bg-destructive/15 text-destructive border-destructive/30"
    : status === "expiring"
      ? "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300"
      : status.startsWith("ok_")
        ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
        : "bg-muted text-muted-foreground border-border";
  return (
    <span className={cn("shrink-0 self-center rounded border px-1.5 py-0.5 text-[10px]", cls)}>
      {STATUS_LABEL[status]}
    </span>
  );
}
