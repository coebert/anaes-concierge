import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AdminSettingsPage = lazy(() =>
  import("./-admin-settings-page").then((module) => ({
    default: module.AdminSettingsPage,
  })),
);

export const Route = createFileRoute("/_authenticated/admin/settings")({
  component: AdminSettingsRoute,
});

function AdminSettingsRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          Loading settings…
        </div>
      }
    >
      <AdminSettingsPage />
    </Suspense>
  );
}
