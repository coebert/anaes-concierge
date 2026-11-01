import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHealthResponse } from "@/lib/health-response";

describe("parseHealthResponse", () => {
  it("handles minimal liveness 200 without checks/version", () => {
    const p = parseHealthResponse(
      200,
      JSON.stringify({ status: "alive", timestamp: "2026-11-01T00:00:00Z" }),
    );
    expect(p.status).toBe("alive");
    expect(p.checks).toBeNull();
    expect(p.version).toBeNull();
  });
  it("handles detailed 503", () => {
    const p = parseHealthResponse(
      503,
      JSON.stringify({
        status: "unhealthy",
        version: "1",
        checks: [{ name: "Database", status: "error" }],
      }),
    );
    expect(p.status).toBe("unhealthy");
    expect(p.checks?.[0]).toMatchObject({ name: "Database", status: "error" });
  });
  it("handles non-JSON bodies and bogus fields without throwing", () => {
    expect(parseHealthResponse(502, "<html>Bad gateway</html>").status).toBe("unhealthy");
    expect(parseHealthResponse(200, "not json").status).toBe("unknown");
    const p = parseHealthResponse(
      200,
      JSON.stringify({ status: 5, checks: [null, { status: "weird" }] }),
    );
    expect(p.status).toBe("unknown");
    expect(p.checks).toEqual([
      { name: "Unnamed check", status: "error", latencyMs: undefined, message: undefined },
    ]);
  });
});

describe("/api/public/health handler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HEALTH_DETAILS_SECRET;
  });
  it("anonymous request does no upstream/DB work and claims only liveness", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.HEALTH_DETAILS_SECRET = "detail-secret";
    const { handleHealthRequest } = await import("@/routes/api/public/health");
    const res = await handleHealthRequest(new Request("https://x/api/public/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("alive");
    expect(body.scope).toBe("liveness");
    expect(body.checks).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("wrong secret is treated as anonymous", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.HEALTH_DETAILS_SECRET = "detail-secret";
    const { handleHealthRequest } = await import("@/routes/api/public/health");
    const res = await handleHealthRequest(
      new Request("https://x/api/public/health", { headers: { "x-health-secret": "nope" } }),
    );
    expect((await res.json()).checks).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
