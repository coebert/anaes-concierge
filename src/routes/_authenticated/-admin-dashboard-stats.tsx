import { Card, CardContent } from "@/components/ui/card";
import { Users } from "lucide-react";

export function DualStat({
  label, icon: Icon, d7, d30,
}: { label: string; icon: typeof Users; d7?: number; d30?: number }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 flex items-baseline gap-4">
            <div>
              <div className="text-xl font-semibold">{d7 ?? "—"}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last 7d</div>
            </div>
            <div>
              <div className="text-xl font-semibold">{d30 ?? "—"}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last 30d</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Stat({
  label, value, icon: Icon,
}: { label: string; value: number | string; icon: typeof Users }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
