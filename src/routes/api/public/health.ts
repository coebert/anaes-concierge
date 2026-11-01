import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { validateJson } from "@/lib/json-validation";
import { secretsMatch } from "@/lib/webhook-auth";

const version = "1.0.0";
const CHECK_TIMEOUT_MS = 4000;
const DETAIL_CACHE_MS = 30_000;

export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  checks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  status: "ok" | "warning" | "error";
  latencyMs?: number;
  message?: string;
}

function getAdminClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function checkDatabase(): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const admin = getAdminClient();
    const { error } = await admin
      .from("profiles")
      .select("id")
      .limit(1)
      .abortSignal(AbortSignal.timeout(CHECK_TIMEOUT_MS));
    if (error) {
      console.error("[health] database check failed", error);
      return {
        name: "Database",
        status: "error",
        latencyMs: Date.now() - started,
        message: "Database connectivity issue",
      };
    }
    return {
      name: "Database",
      status: "ok",
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    console.error("[health] database check threw", err);
    return {
      name: "Database",
      status: "error",
      latencyMs: Date.now() - started,
      message: "Database connectivity issue",
    };
  }
}

async function checkAiGateway(): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      return {
        name: "AI Gateway",
        status: "warning",
        latencyMs: Date.now() - started,
        message: "Not configured",
      };
    }
    const res = await fetch("https://ai.gateway.lovable.dev/v1/models", {
      headers: {
        "Lovable-API-Key": key,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[health] AI gateway HTTP", res.status);
      return {
        name: "AI Gateway",
        status: "error",
        latencyMs: Date.now() - started,
        message: "Upstream unavailable",
      };
    }
    return {
      name: "AI Gateway",
      status: "ok",
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    console.error("[health] AI gateway check threw", err);
    return {
      name: "AI Gateway",
      status: "error",
      latencyMs: Date.now() - started,
      message: "Upstream unavailable",
    };
  }
}

async function checkJsonValidation(): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const schema = z.object({ status: z.literal("ok"), count: z.number().int().min(0) });
    const result = validateJson({ status: "ok", count: 42 }, schema);
    if (!result.ok) {
      return {
        name: "JSON Validation",
        status: "error",
        latencyMs: Date.now() - started,
        message: "Self-test failed",
      };
    }
    const bad = validateJson({ status: "bad", count: -1 }, schema);
    if (bad.ok) {
      return {
        name: "JSON Validation",
        status: "error",
        latencyMs: Date.now() - started,
        message: "Self-test failed",
      };
    }
    return {
      name: "JSON Validation",
      status: "ok",
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    console.error("[health] json validation check threw", err);
    return {
      name: "JSON Validation",
      status: "error",
      latencyMs: Date.now() - started,
      message: "Self-test failed",
    };
  }
}

async function checkClwRotaConfig(): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const apiKey = process.env.CLWROTA_API_KEY;
    const baseUrl = process.env.CLWROTA_BASE_URL;
    if (!apiKey || !baseUrl) {
      return {
        name: "External integration",
        status: "warning",
        latencyMs: Date.now() - started,
        message: "Not configured",
      };
    }
    const probeUrl = `${baseUrl.replace(/\/+$/, "")}/central_api/query/services?fields=id_name`;
    const res = await fetch(probeUrl, {
      method: "GET",
      headers: { "X-Auth": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      redirect: "manual",
    });
    if (!res.ok) {
      console.error("[health] CLWRota HTTP", res.status);
      return {
        name: "External integration",
        status: "error",
        latencyMs: Date.now() - started,
        message: "Upstream unavailable",
      };
    }
    return {
      name: "External integration",
      status: "ok",
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    console.error("[health] CLWRota check threw", err);
    return {
      name: "External integration",
      status: "error",
      latencyMs: Date.now() - started,
      message: "Upstream unavailable",
    };
  }
}

async function checkKeyTables(): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const admin = getAdminClient();
    const tables = [
      "profiles",
      "rota_assignments",
      "leave_requests",
      "theatre_sessions",
      "theatres",
      "job_plans",
      "custom_rota_rules",
      "clwrota_sync_state",
    ];
    const results = await Promise.all(
      tables.map(async (t) => {
        const { error } = await admin
          .from(t)
          .select("id")
          .limit(1)
          .abortSignal(AbortSignal.timeout(CHECK_TIMEOUT_MS));
        return { ok: !error };
      }),
    );
    const failed = results.filter((r) => !r.ok).length;
    if (failed > 0) {
      console.error("[health] key tables failed count", failed);
      return {
        name: "Key Tables",
        status: "error",
        latencyMs: Date.now() - started,
        message: "One or more tables unreachable",
      };
    }
    return {
      name: "Key Tables",
      status: "ok",
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    console.error("[health] key tables check threw", err);
    return {
      name: "Key Tables",
      status: "error",
      latencyMs: Date.now() - started,
      message: "Database connectivity issue",
    };
  }
}

let cachedDetail: { at: number; promise: Promise<HealthCheck[]> } | null = null;

/** Detailed readiness, deduplicated and cached so bursts don't fan out upstream. */
function runDetailedChecks(): Promise<HealthCheck[]> {
  const now = Date.now();
  if (cachedDetail && now - cachedDetail.at < DETAIL_CACHE_MS) return cachedDetail.promise;
  const promise = Promise.all([
    checkDatabase(),
    checkAiGateway(),
    checkJsonValidation(),
    checkClwRotaConfig(),
    checkKeyTables(),
  ]);
  cachedDetail = { at: now, promise };
  promise.catch(() => {
    cachedDetail = null;
  });
  return promise;
}

export function summarise(checks: HealthCheck[]): HealthResponse["status"] {
  if (checks.some((c) => c.status === "error")) return "unhealthy";
  if (checks.some((c) => c.status === "warning")) return "degraded";
  return "healthy";
}

export async function handleHealthRequest(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
  // Authorise BEFORE doing any dependency work. Anonymous callers get a cheap
  // liveness answer that makes no database, AI or CLWRota calls and claims
  // nothing about dependency readiness.
  if (!secretsMatch(request.headers.get("x-health-secret"), process.env.HEALTH_DETAILS_SECRET)) {
    return Response.json(
      { status: "alive", scope: "liveness", timestamp: new Date().toISOString(), version },
      { status: 200, headers },
    );
  }
  const checks = await runDetailedChecks();
  const status = summarise(checks);
  const body: HealthResponse = { status, timestamp: new Date().toISOString(), version, checks };
  return Response.json(body, { status: status === "unhealthy" ? 503 : 200, headers });
}

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async ({ request }) => handleHealthRequest(request),
    },
  },
});
