import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Globe,
  Database,
  BrainCircuit,
  FileJson,
  RefreshCw,
  Server,
  XCircle,
  Clock,
} from "lucide-react";
import { formatDateTimeGB } from "@/lib/utils";

interface HealthCheck {
  name: string;
  status: "ok" | "warning" | "error";
  latencyMs?: number;
  message?: string;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  checks: HealthCheck[];
}

export const Route = createFileRoute("/health")({
  head: () => ({
    meta: [
      { title: "Health Check — Salisbury Anaesthetics Rota" },
      { name: "description", content: "System health and dependency status" },
    ],
  }),
  component: HealthPage,
});

function HealthPage() {
  const {
    data: health,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery<HealthResponse>({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/public/health");
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Health API returned ${res.status}: ${text}`);
      }
      return res.json();
    },
    refetchInterval: 30000,
    staleTime: 5000,
  });

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {/* Header */}
      <header className="border-b bg-card px-4 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">System Health</h1>
              <p className="text-xs text-muted-foreground">
                Salisbury Anaesthetics Rota — dependency &amp; route status
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`mr-1 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {health && <OverallBadge status={health.status} />}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto w-full max-w-4xl flex-1 p-4">
        {isLoading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState error={error as Error} onRetry={() => refetch()} />
        ) : health ? (
          <div className="space-y-6">
            {/* Summary bar */}
            <div className="grid gap-4 sm:grid-cols-3">
              <SummaryCard
                icon={CheckCircle2}
                label="Healthy"
                value={health.checks.filter((c) => c.status === "ok").length}
                color="text-success"
                bg="bg-emerald-50"
              />
              <SummaryCard
                icon={AlertCircle}
                label="Warnings"
                value={health.checks.filter((c) => c.status === "warning").length}
                color="text-warning"
                bg="bg-amber-50"
              />
              <SummaryCard
                icon={XCircle}
                label="Errors"
                value={health.checks.filter((c) => c.status === "error").length}
                color="text-red-600"
                bg="bg-red-50"
              />
            </div>

            {/* Checks grid */}
            <div className="grid gap-4 sm:grid-cols-2">
              {health.checks.map((check) => (
                <CheckCard key={check.name} check={check} />
              ))}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Checked: {formatDateTimeGB(health.timestamp)}</span>
              <span>Version: {health.version}</span>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function OverallBadge({ status }: { status: HealthResponse["status"] }) {
  const variants: Record<string, { label: string; className: string }> = {
    healthy: { label: "Healthy", className: "bg-success-muted text-success hover:bg-success-muted" },
    degraded: { label: "Degraded", className: "bg-warning-muted text-warning hover:bg-warning-muted" },
    unhealthy: { label: "Unhealthy", className: "bg-red-100 text-red-700 hover:bg-red-100" },
  };
  const v = variants[status] ?? variants.unhealthy;
  return <Badge className={v.className}>{v.label}</Badge>;
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  color,
  bg,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${bg} ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-2xl font-semibold">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function CheckCard({ check }: { check: HealthCheck }) {
  const iconMap = {
    ok: CheckCircle2,
    warning: AlertCircle,
    error: XCircle,
  };
  const Icon = iconMap[check.status];
  const colorMap = {
    ok: "text-success",
    warning: "text-warning",
    error: "text-red-600",
  };
  const borderMap = {
    ok: "border-emerald-200",
    warning: "border-amber-200",
    error: "border-red-200",
  };

  return (
    <Card className={`border ${borderMap[check.status]}`}>
      <CardContent className="flex items-start gap-3 p-4">
        <div className={`mt-0.5 ${colorMap[check.status]}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{check.name}</span>
            {check.latencyMs !== undefined && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {check.latencyMs}ms
              </span>
            )}
          </div>
          {check.message && (
            <p className="mt-1 text-xs text-muted-foreground break-words">
              {check.message}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <Skeleton className="mt-2 h-6 w-16" />
              <Skeleton className="mt-1 h-4 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="h-5 w-5" />
              <Skeleton className="mt-2 h-4 w-32" />
              <Skeleton className="mt-1 h-3 w-48" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-50 text-red-600">
        <XCircle className="h-8 w-8" />
      </div>
      <h2 className="mt-4 text-lg font-semibold">Health check failed</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {error.message}
      </p>
      <Button className="mt-6" onClick={onRetry}>
        <RefreshCw className="mr-2 h-4 w-4" />
        Try again
      </Button>
    </div>
  );
}
