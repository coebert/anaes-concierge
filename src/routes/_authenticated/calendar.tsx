import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  GlobalWeekGrid, WeekPicker, StaffPicker, startOfWeek,
} from "@/components/rota-views";

export const Route = createFileRoute("/_authenticated/calendar")({
  component: CalendarPage,
});

function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Global calendar</h1>
          <p className="text-sm text-muted-foreground">
            Read-only theatre grid for the week. Click a name to open that staff member's view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StaffPicker
            onChange={(staffId) =>
              navigate({ to: "/calendar/staff/$staffId", params: { staffId } })
            }
          />
          <WeekPicker weekStart={weekStart} onChange={setWeekStart} />
        </div>
      </div>
      <GlobalWeekGrid weekStart={weekStart} />
    </div>
  );
}
