import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/calendar")({
  component: CalendarLayout,
});

function CalendarLayout() {
  return <Outlet />;
}
