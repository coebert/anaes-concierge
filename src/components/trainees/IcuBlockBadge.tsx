import { Badge } from "@/components/ui/badge";

/**
 * Shared badge for trainees whose remaining rotation is ICU-only.
 *
 * Rendered consistently across the trainees list, per-trainee detail page,
 * the start-date audit, and the admin post-sync theatre audit so that a
 * trainee with no theatre lists doesn't keep producing false alarms.
 */
export function IcuBlockBadge({
  className = "",
  title = "All remaining assignments in this rotation are ICU shifts — no theatre lists scheduled.",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={
        "text-xs border-sky-500/60 bg-sky-500/10 text-sky-700 dark:text-sky-300 " +
        className
      }
      title={title}
    >
      ICU block only
    </Badge>
  );
}
