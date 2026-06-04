import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/app-shell";
import { Stethoscope } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  // Supabase stores the session in localStorage, which is not available on
  // the server. Rendering this gate on the server makes every hard refresh
  // look "signed out" until the client hydrates, and any protected serverFn
  // loaders below run unauthenticated and 401. Client-render the subtree.
  ssr: false,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !isAuthenticated) {
      void navigate({ to: "/login" });
    }
  }, [loading, isAuthenticated, navigate]);

  if (loading || !isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Stethoscope className="h-8 w-8 animate-pulse text-primary" />
          <p className="text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
