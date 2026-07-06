import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Standard page header used at the top of every route.
 *
 * - `title` sets the H1 for the page (semantic + typographic anchor).
 * - `description` renders a muted subtitle when provided.
 * - `actions` sits on the right on desktop, wraps below on mobile.
 * - `children` (usually tab/segmented control) renders under the title row.
 *
 * Kept intentionally dumb: no layout responsibilities beyond spacing.
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 space-y-3 md:mb-6", className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-balance text-foreground md:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
