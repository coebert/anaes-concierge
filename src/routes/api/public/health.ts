import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { validateJson } from "@/lib/json-validation";

const version = "1.0.0";

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  checks: HealthCheck[];
}

interface HealthCheck {
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
      .from("profiles_v")
      .select("id", { count: "exact", head: true })
      .limit(1);
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
        const { error } = await admin.from(t).select("id", { count: "exact", head: true }).limit(1);
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


function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const checks = await Promise.all([
          checkDatabase(),
          checkAiGateway(),
          checkJsonValidation(),
          checkClwRotaConfig(),
          checkKeyTables(),
        ]);

        const hasError = checks.some((c) => c.status === "error");
        const hasWarning = checks.some((c) => c.status === "warning");
        const status: HealthResponse["status"] = hasError
          ? "unhealthy"
          : hasWarning
            ? "degraded"
            : "healthy";

        // Detailed per-check output (latencies, configured-or-not flags, upstream
        // names) is only returned to trusted callers presenting the shared
        // X-Health-Secret header. Anonymous callers get a minimal status only,
        // so the endpoint can't be used to map infrastructure or detect missing
        // secrets. When no secret is configured, default to minimal output.
        const provided = request.headers.get("x-health-secret") ?? "";
        const expected = process.env.HEALTH_DETAILS_SECRET ?? "";
        const detailed = expected.length > 0 && timingSafeEqualStr(provided, expected);

        const body: HealthResponse | { status: HealthResponse["status"]; timestamp: string } = detailed
          ? { status, timestamp: new Date().toISOString(), version, checks }
          : { status, timestamp: new Date().toISOString() };

        return Response.json(body, {
          status: status === "unhealthy" ? 503 : 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        });
      },
    },
  },
});
