import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StaffWeekView } from "@/components/rota-views";

export const Route = createFileRoute("/_authenticated/calendar/staff/$staffId")({
  component: StaffCalendarPage,
});

function StaffCalendarPage() {
  const { staffId } = Route.useParams();
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link to="/calendar">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to global calendar
        </Link>
      </Button>
      <StaffWeekView staffId={staffId} />
    </div>
  );
}
