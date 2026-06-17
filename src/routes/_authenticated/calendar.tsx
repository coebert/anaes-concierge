import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  GlobalWeekGrid, StaffPicker, ViewModeToggle, PeriodNav, SpecialtyLegend, buildDays,
  type ViewMode,
} from "@/components/rota-views";

export const Route = createFileRoute("/_authenticated/calendar")({
  component: CalendarPage,
});

function CalendarPage() {
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [mode, setMode] = useState<ViewMode>("week");
  const navigate = useNavigate();

  const days = useMemo(() => buildDays(anchor, mode, false), [anchor, mode]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Global calendar</h1>
          <p className="text-sm text-muted-foreground">
            Read-only theatre grid. Click a name to open that staff member's view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StaffPicker
            onChange={(staffId) =>
              navigate({ to: "/calendar/staff/$staffId", params: { staffId } })
            }
          />
          <ViewModeToggle mode={mode} onChange={setMode} />
          <PeriodNav anchor={anchor} mode={mode} onChange={setAnchor} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Legend:</span>
        <span className="inline-flex items-center gap-1">
          <span className="font-bold text-foreground">Jane Doe</span>
          <span>= Consultant</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className={cn("text-blue-600 dark:text-blue-400")}>John Smith</span>
          <span>= Solo trainee</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Badge variant="outline" className="px-1 py-0 text-[9px]">solo</Badge>
          <span>+ blue</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-foreground">Alex Lee (ST4)</span>
          <span>= Trainee grade</span>
        </span>
      </div>
      <SpecialtyLegend />
      <GlobalWeekGrid weekStart={days[0]} days={days} />
    </div>
  );
}
