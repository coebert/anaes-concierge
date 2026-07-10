/**
 * Verifies the dev-mode diagnostic in `invalidateWellbeing`:
 *   - one `console.debug` line per invalidated key (admin-wellbeing, my-wellbeing)
 *   - each line carries the caller-provided reason
 *   - each line carries an ISO timestamp
 *   - the underlying `invalidateQueries` calls still fire with the correct keys
 *
 * Vitest sets `import.meta.env.DEV` to true, matching the runtime dev bundle;
 * the prod no-op path is covered by inspection (the whole helper body is
 * gated behind `if (!import.meta.env.DEV) return;`).
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invalidateWellbeing } from "@/features/wellbeing/invalidate";

describe("invalidateWellbeing — dev-mode diagnostics", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let qc: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    qc = new QueryClient();
    invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  });

  afterEach(() => {
    debugSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it("logs one line per wellbeing query key with the caller-supplied reason", () => {
    invalidateWellbeing(qc, "exception.withdraw");

    // Exactly two log lines: one per invalidated key.
    expect(debugSpy).toHaveBeenCalledTimes(2);

    const lines = debugSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const adminLine = lines.find((l: string) => l.includes('["admin-wellbeing"]'));
    const meLine = lines.find((l: string) => l.includes('["my-wellbeing"]'));

    expect(adminLine, "missing admin-wellbeing debug line").toBeDefined();
    expect(meLine, "missing my-wellbeing debug line").toBeDefined();

    for (const line of [adminLine!, meLine!]) {
      expect(line).toContain("[wellbeing]");
      expect(line).toContain("reason=exception.withdraw");
      // ISO-8601 timestamp (…T…Z) somewhere in the line.
      expect(line).toMatch(/at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it("falls back to reason=unspecified when the caller omits a reason", () => {
    invalidateWellbeing(qc);
    const lines = debugSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("reason=unspecified");
    }
  });

  it("still triggers the underlying invalidateQueries for both keys", () => {
    invalidateWellbeing(qc, "leave.cancel");

    // Two invalidateQueries calls — one per key — regardless of logging.
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    const keys = invalidateSpy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["admin-wellbeing"]);
    expect(keys).toContainEqual(["my-wellbeing"]);
  });
});
