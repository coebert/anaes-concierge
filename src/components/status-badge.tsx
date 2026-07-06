import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "default" | "success" | "warning" | "info" | "destructive";

const toneStyles: Record<StatusTone, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  info: "bg-info-muted text-info",
  destructive: "bg-destructive-muted text-destructive",
};

export function StatusBadge({
  tone = "default",
  children,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        toneStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
