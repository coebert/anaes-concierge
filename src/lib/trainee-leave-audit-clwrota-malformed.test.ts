/**
 * Integration tests for **malformed** CLWRota API payloads.
 *
 * Companion to trainee-leave-audit-clwrota-integration.test.ts — that file
 * covers well-formed payloads with missing/null status. This file makes sure
 * the same end-to-end pipeline (mocked fetch → parse → row-extract → pick
 * status → classifyLeaveOverlap) survives every realistic upstream
 * malformation we have seen or could plausibly see:
 *
 *   - missing top-level `columns` / `rows` / `data`
 *   - wrong types (rows: object, columns: string, data: number, etc.)
 *   - unexpected nesting (status inside an unrelated nested object,
 *     leave_request being a string instead of an object, etc.)
 *   - completely non-JSON bodies (HTML error pages, empty body)
 *
 * Acceptance criteria (per task brief):
 *   1. The pipeline never throws on a malformed payload.
 *   2. Every row that lacks a recognisable status field classifies as
 *      `unknown` via classifyLeaveOverlap (counted:false, reason contains
 *      "unknown"). Rows that yield zero parsed entries are vacuously fine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLeaveOverlap } from "./trainee-leave-audit-classify";

// ---- Mirror of clwrota.functions.ts internals (kept in sync intentionally) ----

function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = k.includes(".")
      ? k.split(".").reduce<unknown>((acc, part) => {
          if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
          return undefined;
        }, row)
      : row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
  }
  return null;
}

const STATUS_KEYS = [
  "leave_request.state",
  "leave_submittal.state",
  "status.name",
  "status",
  "state",
  "Status",
  "approval_status",
];

function rowsFromCentralApi(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    // Filter out non-object entries defensively — a malformed payload may
    // contain strings/numbers/null in an otherwise-array shape.
    return parsed.filter(
      (r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r),
    );
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const cols = obj["columns"];
    const rowsRaw = obj["rows"];
    if (Array.isArray(cols) && Array.isArray(rowsRaw)) {
      const fieldNames = (cols as unknown[]).map((c) =>
        c && typeof c === "object" && "field_name" in (c as Record<string, unknown>)
          ? String((c as Record<string, unknown>).field_name ?? "")
          : "",
      );
      if (rowsRaw.length > 0 && !Array.isArray(rowsRaw[0]) && typeof rowsRaw[0] === "object") {
        return rowsRaw.filter(
          (r): r is Record<string, unknown> =>
            r !== null && typeof r === "object" && !Array.isArray(r),
        );
      }
      return (rowsRaw as unknown[]).map((r) => {
        const out: Record<string, unknown> = {};
        if (Array.isArray(r)) {
          r.forEach((cell, i) => {
            out[fieldNames[i]] = cell;
          });
        }
        return out;
      });
    }
    if (Array.isArray(obj["data"])) {
      return (obj["data"] as unknown[]).filter(
        (r): r is Record<string, unknown> =>
          r !== null && typeof r === "object" && !Array.isArray(r),
      );
    }
  }
  return [];
}

/**
 * Safe end-to-end pipeline runner. Returns either { statuses } or
 * { statuses: [], parseError } — but NEVER throws. The whole point of these
 * tests is to pin down "never crashes" as a contract.
 */
async function fetchAndExtractStatusesSafe(
  url: string,
): Promise<{ statuses: Array<string | null>; parseError: string | null }> {
  let text = "";
  try {
    const res = await fetch(url, { headers: { "X-Auth": "test-key" } });
    text = await res.text();
  } catch (err) {
    return { statuses: [], parseError: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { statuses: [], parseError: err instanceof Error ? err.message : String(err) };
  }
  let rows: Record<string, unknown>[] = [];
  try {
    rows = rowsFromCentralApi(parsed);
  } catch (err) {
    return { statuses: [], parseError: err instanceof Error ? err.message : String(err) };
  }
  const statuses = rows.map((r) => {
    try {
      return pick(r, STATUS_KEYS);
    } catch {
      // pick must never throw — but if a future refactor introduces a
      // crash, surface it as "null → unknown" rather than blowing up the
      // whole sync.
      return null;
    }
  });
  return { statuses, parseError: null };
}

// ---- Fetch mocking ----

const originalFetch = globalThis.fetch;
function mockFetchOnceWith(body: string) {
  globalThis.fetch = vi.fn(async () =>
    new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function expectAllUnknown(statuses: Array<string | null>) {
  for (const s of statuses) {
    const result = classifyLeaveOverlap(s);
    expect(result.counted).toBe(false);
    expect(result.reason.toLowerCase()).toContain("unknown");
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("CLWRota malformed payloads → no crash, missing status → unknown", () => {
  describe("invalid JSON / non-JSON bodies", () => {
    it("handles an HTML error page (CLWRota login redirect) without crashing", async () => {
      mockFetchOnceWith("<!DOCTYPE html><html><body>Session expired</body></html>");
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeTruthy(); // JSON.parse fails — caught, not thrown
      expect(statuses).toEqual([]);
    });

    it("handles an empty response body without crashing", async () => {
      mockFetchOnceWith("");
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeTruthy();
      expect(statuses).toEqual([]);
    });

    it("handles truncated JSON without crashing", async () => {
      mockFetchOnceWith('[{"leave_request": {"state":');
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeTruthy();
      expect(statuses).toEqual([]);
    });
  });

  describe("missing top-level keys (columns / rows / data)", () => {
    it("central_api shape with `columns` present but no `rows` → 0 rows, no crash", async () => {
      mockFetchOnceWith(
        JSON.stringify({
          columns: [{ field_name: "leave_request.state" }],
          // rows: missing entirely
        }),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("central_api shape with `rows` present but no `columns` → 0 rows, no crash", async () => {
      mockFetchOnceWith(
        JSON.stringify({
          rows: [["approved"], ["pending"]],
        }),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("wrapper object missing `data` array entirely → 0 rows, no crash", async () => {
      mockFetchOnceWith(JSON.stringify({ meta: { count: 0 } }));
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("completely empty object {} → 0 rows, no crash", async () => {
      mockFetchOnceWith("{}");
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });
  });

  describe("wrong types for top-level keys", () => {
    it("`columns` is a string instead of an array → 0 rows, no crash", async () => {
      mockFetchOnceWith(
        JSON.stringify({
          columns: "leave_request.state,person.email",
          rows: [["approved", "a@x"]],
        }),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("`rows` is an object instead of an array → 0 rows, no crash", async () => {
      mockFetchOnceWith(
        JSON.stringify({
          columns: [{ field_name: "leave_request.state" }],
          rows: { "0": ["approved"] },
        }),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("`data` is a number instead of an array → 0 rows, no crash", async () => {
      mockFetchOnceWith(JSON.stringify({ data: 42 }));
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("top-level is a JSON number → 0 rows, no crash", async () => {
      mockFetchOnceWith("12345");
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("top-level is a JSON string → 0 rows, no crash", async () => {
      mockFetchOnceWith(JSON.stringify("approved"));
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("top-level is JSON null → 0 rows, no crash", async () => {
      mockFetchOnceWith("null");
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([]);
    });

    it("array containing non-object entries (strings, nulls, numbers) → filtered out, no crash", async () => {
      mockFetchOnceWith(
        JSON.stringify([
          "approved",
          null,
          42,
          { leave_request: { state: null } }, // real row with null status
        ]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      // Only the one real object survives; its status is null → unknown.
      expect(statuses).toEqual([null]);
      expectAllUnknown(statuses);
    });
  });

  describe("malformed central_api column/row alignment", () => {
    it("columns entries missing `field_name` → row cells map to empty keys, status still unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify({
          columns: [{ ui_name: "Status" }, { ui_name: "Email" }], // no field_name
          rows: [["approved", "a@x"]],
        }),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      // Row decoded as { "": "a@x" } — no status keys match → null → unknown.
      expect(statuses).toHaveLength(1);
      expectAllUnknown(statuses);
    });

    it("columns entries are strings (not objects) → 0 status, no crash", async () => {
      mockFetchOnceWith(
        JSON.stringify({
          columns: ["leave_request.state", "person.email"],
          rows: [["approved", "a@x"]],
        }),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toHaveLength(1);
      // Cells map to "" key (no field_name extractable) → no status match → unknown.
      expectAllUnknown(statuses);
    });

    it("row arrays shorter than columns → undefined cells, no crash, status unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify({
          columns: [
            { field_name: "leave_request.state" },
            { field_name: "person.email" },
          ],
          rows: [
            [], // empty row
            ["approved"], // missing email cell
          ],
        }),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toHaveLength(2);
      // First row: no cells at all → status undefined → null → unknown.
      // Second row: leave_request is the STRING "approved" (not an object),
      // so dotted-path traversal returns undefined → null → unknown.
      expectAllUnknown(statuses);
    });
  });

  describe("unexpected nesting", () => {
    it("status nested under an unrelated key (e.g. `payload.leave_request.state`) is not picked → unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify([
          {
            payload: { leave_request: { state: "approved" } },
            person: { email: "a@x" },
          },
        ]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([null]);
      expectAllUnknown(statuses);
    });

    it("leave_request is a STRING instead of an object → dotted traversal returns null, classified as unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify([
          { leave_request: "approved", person: { email: "a@x" } },
          { leave_request: "pending" },
        ]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([null, null]);
      expectAllUnknown(statuses);
    });

    it("leave_request is an ARRAY instead of an object → traversal returns null, classified as unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify([
          { leave_request: ["approved", "pending"] },
          { leave_request: [] },
        ]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([null, null]);
      expectAllUnknown(statuses);
    });

    it("status is a deeply nested object instead of a scalar → not pickable, classified as unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify([
          { leave_request: { state: { value: "approved", label: "Approved" } } },
          { status: { name: { localized: "approved" } } }, // status.name is an object, not string
        ]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      // pick() only accepts string/number/boolean leaves → both return null.
      expect(statuses).toEqual([null, null]);
      expectAllUnknown(statuses);
    });

    it("status is an ARRAY → pick rejects non-scalar, classified as unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify([
          { status: ["approved", "pending"] },
          { leave_request: { state: ["approved"] } },
        ]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([null, null]);
      expectAllUnknown(statuses);
    });

    it("person object is null (defensive) → status lookup still safe, classified as unknown", async () => {
      mockFetchOnceWith(
        JSON.stringify([{ person: null, leave_request: null, leave_submittal: null }]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      expect(statuses).toEqual([null]);
      expectAllUnknown(statuses);
    });
  });

  describe("mixed malformed + valid rows", () => {
    it("malformed neighbours never destabilise valid rows in the same batch", async () => {
      mockFetchOnceWith(
        JSON.stringify([
          "garbage string row",
          null,
          { leave_request: { state: "approved" } }, // valid → counted
          { leave_request: "approved" }, // wrong type → unknown
          { leave_request: { state: null } }, // null → unknown
          { leave_request: { state: { nested: "approved" } } }, // wrong shape → unknown
          {}, // empty → unknown
        ]),
      );
      const { statuses, parseError } = await fetchAndExtractStatusesSafe("https://clwrota.test/leave");
      expect(parseError).toBeNull();
      // Non-object entries are filtered; 5 object rows remain.
      expect(statuses).toHaveLength(5);
      const classified = statuses.map((s) => classifyLeaveOverlap(s));
      expect(classified[0].counted).toBe(true);
      expect(classified[0].reason.toLowerCase()).toContain("approved");
      for (let i = 1; i < classified.length; i++) {
        expect(classified[i].counted).toBe(false);
        expect(classified[i].reason.toLowerCase()).toContain("unknown");
      }
    });
  });
});
