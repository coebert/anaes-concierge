import type { ComponentType, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "info" | "destructive";

const toneStyles: Record<Tone, { icon: string; delta: string }> = {
  default: { icon: "bg-muted text-muted-foreground", delta: "text-muted-foreground" },
  success: { icon: "bg-success-muted text-success", delta: "text-success" },
  warning: { icon: "bg-warning-muted text-warning", delta: "text-warning" },
  info: { icon: "bg-info-muted text-info", delta: "text-info" },
  destructive: { icon: "bg-destructive-muted text-destructive", delta: "text-destructive" },
};

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  tone?: Tone;
  className?: string;
}

export function StatCard({
  label,
  value,
  hint,
  delta,
  icon: Icon,
  tone = "default",
  className,
}: StatCardProps) {
  const t = toneStyles[tone];
  return (
    <Card className={cn("relative overflow-hidden", className)}>
      <CardContent className="flex items-start gap-4 p-4 sm:p-5">
        {Icon ? (
          <div
            className={cn(
              "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
              t.icon,
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <div className="text-2xl font-semibold tabular-nums leading-tight text-foreground">
              {value}
            </div>
            {delta ? (
              <div className={cn("text-xs font-medium tabular-nums", t.delta)}>{delta}</div>
            ) : null}
          </div>
          {hint ? (
            <div className="mt-1 truncate text-xs text-muted-foreground">{hint}</div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
