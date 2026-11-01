export type CheckStatus = "ok" | "warning" | "error";
export interface ParsedHealthCheck {
  name: string;
  status: CheckStatus;
  latencyMs?: number;
  message?: string;
}
export type OverallStatus = "alive" | "healthy" | "degraded" | "unhealthy" | "unknown";
export interface ParsedHealth {
  status: OverallStatus;
  timestamp: string | null;
  version: string | null;
  /** null => liveness-only response; dependency readiness was NOT checked. */
  checks: ParsedHealthCheck[] | null;
  httpStatus: number;
}

const OVERALL = new Set(["alive", "healthy", "degraded", "unhealthy"]);
const CHECK = new Set(["ok", "warning", "error"]);

/**
 * Tolerant parser for /api/public/health. Never throws on 503, minimal 200,
 * missing fields or non-JSON bodies; the caller decides how to render.
 */
export function parseHealthResponse(httpStatus: number, bodyText: string): ParsedHealth {
  let json: unknown = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = null;
  }
  const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (!obj) {
    return { status: httpStatus >= 500 ? "unhealthy" : "unknown", timestamp: null, version: null, checks: null, httpStatus };
  }
  const rawStatus = typeof obj.status === "string" && OVERALL.has(obj.status) ? (obj.status as OverallStatus) : "unknown";
  const status: OverallStatus = rawStatus === "unknown" && httpStatus >= 500 ? "unhealthy" : rawStatus;
  const checks = Array.isArray(obj.checks)
    ? obj.checks
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({
          name: typeof c.name === "string" ? c.name : "Unnamed check",
          status: (typeof c.status === "string" && CHECK.has(c.status) ? c.status : "error") as CheckStatus,
          latencyMs: typeof c.latencyMs === "number" ? c.latencyMs : undefined,
          message: typeof c.message === "string" ? c.message : undefined,
        }))
    : null;
  return {
    status,
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
    version: typeof obj.version === "string" ? obj.version : null,
    checks,
    httpStatus,
  };
}
