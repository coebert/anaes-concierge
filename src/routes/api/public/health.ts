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
    const { data, error } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) {
      return {
        name: "Database",
        status: "error",
        latencyMs: Date.now() - started,
        message: error.message,
      };
    }
    return {
      name: "Database",
      status: "ok",
      latencyMs: Date.now() - started,
      message: "Connected; profiles table accessible",
    };
  } catch (err) {
    return {
      name: "Database",
      status: "error",
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : "Unknown DB error",
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
        message: "LOVABLE_API_KEY not configured",
      };
    }
    // Lightweight probe: hit the models endpoint rather than running inference
    const res = await fetch("https://ai.gateway.lovable.dev/v1/models", {
      headers: {
        "Lovable-API-Key": key,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
    });
    if (!res.ok) {
      return {
        name: "AI Gateway",
        status: "error",
        latencyMs: Date.now() - started,
        message: `HTTP ${res.status} from AI Gateway`,
      };
    }
    return {
      name: "AI Gateway",
      status: "ok",
      latencyMs: Date.now() - started,
      message: "Models endpoint reachable",
    };
  } catch (err) {
    return {
      name: "AI Gateway",
      status: "error",
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : "Network error",
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
        message: `Self-test failed: ${result.error}`,
      };
    }
    // Also verify a bad payload is rejected
    const bad = validateJson({ status: "bad", count: -1 }, schema);
    if (bad.ok) {
      return {
        name: "JSON Validation",
        status: "error",
        latencyMs: Date.now() - started,
        message: "Self-test failed: bad payload was accepted",
      };
    }
    return {
      name: "JSON Validation",
      status: "ok",
      latencyMs: Date.now() - started,
      message: "Zod schema parsing operational",
    };
  } catch (err) {
    return {
      name: "JSON Validation",
      status: "error",
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : "Unknown error",
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
        name: "CLWRota API",
        status: "warning",
        latencyMs: Date.now() - started,
        message: "CLWROTA_API_KEY or CLWROTA_BASE_URL not configured",
      };
    }
    const probeUrl = `${baseUrl.replace(/\/+$/, "")}/central_api/query/services?fields=id_name`;
    const res = await fetch(probeUrl, {
      method: "GET",
      headers: { "X-Auth": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        name: "CLWRota API",
        status: "error",
        latencyMs: Date.now() - started,
        message: `HTTP ${res.status} from ${probeUrl}`,
      };
    }
    return {
      name: "CLWRota API",
      status: "ok",
      latencyMs: Date.now() - started,
      message: `Central API reachable (${baseUrl})`,
    };
  } catch (err) {
    return {
      name: "CLWRota API",
      status: "error",
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : "Network error",
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
        return { table: t, ok: !error };
      }),
    );
    const missing = results.filter((r) => !r.ok).map((r) => r.table);
    if (missing.length > 0) {
      return {
        name: "Key Tables",
        status: "error",
        latencyMs: Date.now() - started,
        message: `Missing or inaccessible: ${missing.join(", ")}`,
      };
    }
    return {
      name: "Key Tables",
      status: "ok",
      latencyMs: Date.now() - started,
      message: `${tables.length} tables accessible`,
    };
  } catch (err) {
    return {
      name: "Key Tables",
      status: "error",
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
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

        const body: HealthResponse = {
          status,
          timestamp: new Date().toISOString(),
          version,
          checks,
        };

        return Response.json(body, {
          status: status === "healthy" ? 200 : status === "degraded" ? 200 : 503,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        });
      },
    },
  },
});
