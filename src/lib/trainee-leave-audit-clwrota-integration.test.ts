/**
 * Integration tests: mock CLWRota API responses (the raw JSON text the
 * Central API returns) and verify the end-to-end pipeline classifies any
 * row with a missing, null, or empty `status` field as "unknown" (i.e.
 * `counted: false`, reason mentions "unknown") via classifyLeaveOverlap.
 *
 * These tests exercise the boundary between the network response and the
 * audit classifier:
 *   mocked fetch → JSON.parse → row-shape detection → pick(statusRaw)
 *                → classifyLeaveOverlap(statusRaw) → assertion
 *
 * They intentionally avoid importing performLeaveSync (which requires
 * Supabase, env vars, and admin context) — we replicate the tiny field
 * picker and the wrapper-shape handling from src/lib/clwrota.functions.ts
 * so we can assert behaviour purely against mocked HTTP bodies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Normalise any of the CLWRota top-level JSON shapes (array, central_api
 * { columns, rows }, or generic wrapper) into a flat row[]. Mirrors the
 * relevant branches of parseRows() in clwrota.functions.ts.
 */
function rowsFromCentralApi(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const cols = obj["columns"];
    const rowsRaw = obj["rows"];
    if (Array.isArray(cols) && Array.isArray(rowsRaw)) {
      const fieldNames = (cols as Array<Record<string, unknown>>).map(
        (c) => String(c.field_name ?? ""),
      );
      // Already keyed objects.
      if (rowsRaw.length > 0 && !Array.isArray(rowsRaw[0]) && typeof rowsRaw[0] === "object") {
        return rowsRaw as Record<string, unknown>[];
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
    // Generic { data: [...] } wrapper.
    if (Array.isArray(obj["data"])) return obj["data"] as Record<string, unknown>[];
  }
  return [];
}

async function fetchAndExtractStatuses(url: string): Promise<Array<string | null>> {
  const res = await fetch(url, { headers: { "X-Auth": "test-key" } });
  const text = await res.text();
  const parsed = JSON.parse(text);
  const rows = rowsFromCentralApi(parsed);
  return rows.map((r) => pick(r, STATUS_KEYS));
}

// ---- Fetch mocking ----

const originalFetch = globalThis.fetch;
function mockFetchOnceWith(body: string) {
  globalThis.fetch = vi.fn(async () =>
    new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  // each test installs its own mock
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---- Assertion helper ----

function expectUnknown(status: string | null) {
  const result = classifyLeaveOverlap(status);
  expect(result.counted).toBe(false);
  expect(result.reason.toLowerCase()).toContain("unknown");
}

// ============================================================================
// Tests
// ============================================================================

describe("CLWRota integration → classifyLeaveOverlap (missing/null status → unknown)", () => {
  it("classifies rows where the entire `status` key is missing as unknown", async () => {
    // Array-of-objects payload (the simplest CLWRota leave_events shape).
    mockFetchOnceWith(
      JSON.stringify([
        {
          "person.email": "alice@example.com",
          "leave_request.start_date": "2026-06-10",
          "leave_request.end_date": "2026-06-12",
          // no status / leave_request.state / leave_submittal.state at all
        },
        {
          "person.email": "bob@example.com",
          "leave_request.start_date": "2026-06-15",
          "leave_request.end_date": "2026-06-16",
        },
      ]),
    );

    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toHaveLength(2);
    statuses.forEach(expectUnknown);
  });

  it("classifies rows where status is JSON null as unknown", async () => {
    mockFetchOnceWith(
      JSON.stringify([
        {
          "person.email": "alice@example.com",
          "leave_request.state": null,
          "leave_submittal.state": null,
          status: null,
        },
      ]),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toEqual([null]);
    statuses.forEach(expectUnknown);
  });

  it("classifies rows where status is the empty string as unknown", async () => {
    mockFetchOnceWith(
      JSON.stringify([
        { "leave_request.state": "" },
        { status: "" },
        { "leave_submittal.state": "" },
      ]),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toEqual([null, null, null]);
    statuses.forEach(expectUnknown);
  });

  it("classifies rows where status is whitespace-only as unknown", async () => {
    mockFetchOnceWith(
      JSON.stringify([
        { "leave_request.state": "   " },
        { status: "\t\n" },
        { "leave_submittal.state": "  \r  " },
      ]),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toEqual([null, null, null]);
    statuses.forEach(expectUnknown);
  });

  it("handles the Rotamap central_api { columns, rows } shape with null status cells", async () => {
    mockFetchOnceWith(
      JSON.stringify({
        columns: [
          { field_name: "person.email", ui_name: "Email" },
          { field_name: "leave_request.start_date", ui_name: "Start" },
          { field_name: "leave_request.end_date", ui_name: "End" },
          { field_name: "leave_request.state", ui_name: "Status" },
        ],
        rows: [
          ["alice@example.com", "2026-06-10", "2026-06-12", null],
          ["bob@example.com", "2026-06-15", "2026-06-16", ""],
          ["carol@example.com", "2026-06-20", "2026-06-21", "   "],
        ],
      }),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toEqual([null, null, null]);
    statuses.forEach(expectUnknown);
  });

  it("handles the generic { data: [...] } wrapper shape with missing status fields", async () => {
    mockFetchOnceWith(
      JSON.stringify({
        data: [
          { "person.email": "alice@example.com" /* no status fields */ },
          { "person.email": "bob@example.com", status: null },
          { "person.email": "carol@example.com", "leave_request.state": "" },
        ],
      }),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toHaveLength(3);
    statuses.forEach(expectUnknown);
  });

  it("does NOT mis-classify mixed batches: real statuses stay counted, missing ones become unknown", async () => {
    mockFetchOnceWith(
      JSON.stringify([
        { "person.email": "a@x", "leave_request.state": "approved" },
        { "person.email": "b@x" /* missing */ },
        { "person.email": "c@x", "leave_request.state": null },
        { "person.email": "d@x", "leave_request.state": "pending" },
        { "person.email": "e@x", "leave_request.state": "" },
        { "person.email": "f@x", "leave_request.state": "cancelled" },
      ]),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    const classified = statuses.map((s) => classifyLeaveOverlap(s));

    // approved + pending → counted
    expect(classified[0]).toEqual({ counted: true, reason: expect.stringMatching(/approved/i) });
    expect(classified[3]).toEqual({ counted: true, reason: expect.stringMatching(/pending/i) });

    // missing / null / empty → unknown
    expect(classified[1].counted).toBe(false);
    expect(classified[1].reason.toLowerCase()).toContain("unknown");
    expect(classified[2].counted).toBe(false);
    expect(classified[2].reason.toLowerCase()).toContain("unknown");
    expect(classified[4].counted).toBe(false);
    expect(classified[4].reason.toLowerCase()).toContain("unknown");

    // cancelled → ignored (known, not unknown)
    expect(classified[5].counted).toBe(false);
    expect(classified[5].reason.toLowerCase()).toContain("cancelled");
  });

  it("falls back through status key priority: prefers leave_request.state, then leave_submittal.state, then status", async () => {
    mockFetchOnceWith(
      JSON.stringify([
        // primary missing → falls back to submittal
        { "leave_submittal.state": "approved" },
        // primary present but blank → fallback chain ignores blank, returns null
        { "leave_request.state": "", "leave_submittal.state": "" },
        // every candidate missing → null → unknown
        {},
      ]),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses[0]).toBe("approved");
    expect(classifyLeaveOverlap(statuses[0]).counted).toBe(true);

    expectUnknown(statuses[1]);
    expectUnknown(statuses[2]);
  });

  it("treats non-string status types (number, boolean) sanely — numbers stringify, but booleans/missing remain unknown", async () => {
    // Defensive: if an upstream change ever leaks a non-string status, we
    // still never blow up; numeric stringification feeds the classifier the
    // literal value (which has no known mapping) so it falls back to ignored.
    mockFetchOnceWith(
      JSON.stringify([
        { status: 0 }, // pick() returns "0"
        { status: false }, // pick() returns "false"
        { status: null }, // pick() returns null → unknown
      ]),
    );
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toEqual(["0", "false", null]);

    // null path → explicit "unknown"
    expectUnknown(statuses[2]);

    // numeric/boolean strings are not known statuses → still ignored (just
    // with the generic "Status \"X\" — ignored" reason).
    for (const s of [statuses[0], statuses[1]]) {
      const r = classifyLeaveOverlap(s);
      expect(r.counted).toBe(false);
    }
  });

  it("handles an empty CLWRota response without throwing (zero rows to classify)", async () => {
    mockFetchOnceWith(JSON.stringify([]));
    const statuses = await fetchAndExtractStatuses("https://clwrota.test/leave");
    expect(statuses).toEqual([]);
  });
});
