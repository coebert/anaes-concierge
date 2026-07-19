import { PageHeader } from "@/components/page-header";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  GlobalWeekGrid, StaffPicker, ViewModeToggle, PeriodNav, SpecialtyLegend, DutyTypeLegend, buildDays,
  type ViewMode,
} from "@/components/rota-views";

export const Route = createFileRoute("/_authenticated/calendar")({
  head: () => ({ meta: [{ title: "Calendar — Salisbury Anaesthetics Rota" }] }),
  component: CalendarPage,
});

function CalendarPage() {
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [mode, setMode] = useState<ViewMode>("week");
  const [search, setSearch] = useState("");
  // Defer the value handed to the heavy grid so typing stays snappy even in
  // month view — React renders the input update at high priority and the
  // grid re-dims at low priority, coalescing bursts of keystrokes.
  const deferredSearch = useDeferredValue(search);
  const navigate = useNavigate();

  const days = useMemo(() => buildDays(anchor, mode, true), [anchor, mode]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Global calendar"
        description="Read-only theatre grid. Click a name to open that staff member's view."
        actions={
          <>
            <StaffPicker
              onChange={(staffId) =>
                navigate({ to: "/calendar/staff/$staffId", params: { staffId } })
              }
            />
            <ViewModeToggle mode={mode} onChange={setMode} />
            <PeriodNav anchor={anchor} mode={mode} onChange={setAnchor} />
          </>
        }
      />
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
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search specialty, consultant, or staff name…"
          className="pl-8 pr-8"
        />
        {search && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setSearch("")}
            className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <GlobalWeekGrid weekStart={days[0]} days={days} searchQuery={deferredSearch} />

    </div>
  );
}
