import { describe, expect, it, vi, afterEach } from "vitest";
import { explicitDateWindow, fetchReportRaw } from "./parsing";

/**
 * Regression: sliced syncs/audits ask for a small explicit window. The rolling
 * "extend the future horizon" helper used to widen every request to ~12 months,
 * so a 3-day slice downloaded a year of rota data and the worker ran out of
 * memory. Callers must be able to opt out.
 */
describe("fetchReportRaw window bounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return new Response("[]", { status: 200 });
      }),
    );
    return seen;
  }

  const base = "https://example.test/report?start_date=2026-01-01&end_date=2026-01-03";

  it("keeps the caller's explicit window when extension is disabled", async () => {
    const seen = stubFetch();
    await fetchReportRaw(explicitDateWindow(base, "2026-01-01", "2026-01-03"), "key", {
      extendFutureWindow: false,
    });
    const u = new URL(seen[0]!);
    expect(u.searchParams.get("start_date")).toBe("2026-01-01");
    expect(u.searchParams.get("end_date")).toBe("2026-01-03");
  });

  it("still extends the horizon by default", async () => {
    const seen = stubFetch();
    await fetchReportRaw(base, "key");
    const u = new URL(seen[0]!);
    expect(u.searchParams.get("end_date")).not.toBe("2026-01-03");
  });
});
