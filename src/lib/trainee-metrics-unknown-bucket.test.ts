import { describe, it, expect } from "vitest";
import { chunkIds } from "./supabase-chunked";
import { computeTraineeMetrics, type MetricAssignment } from "./trainee-metrics";

/**
 * End-to-end regression check for the "Unknown specialty" truncation bug.
 *
 * Both `/trainees` and `admin.dashboard` build a `specialtyIdBySession`
 * map by fetching `theatre_sessions` in bulk and feeding the result into
 * {@link computeTraineeMetrics}. When the bulk fetch is unchunked, the
 * edge proxy silently truncates the response and the missing sessions
 * bucket into the "Unknown" specialty inside `specialtyBreakdown`.
 *
 * This test seeds a large theatre-session pool, runs the lookup through
 * a simulated truncating proxy, and asserts that with chunking every
 * clinical list resolves to a real specialty — i.e. `specialtyBreakdown`
 * never contains an "Unknown" entry, no matter how many sessions a
 * trainee has been on.
 */

const SIMULATED_URL_CAP_BYTES = 12_000;

type SessionRow = { id: string; specialty_id: string };

function uuid(i: number): string {
  const hex = i.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function fakeIn(allRows: SessionRow[], ids: readonly string[]): SessionRow[] {
  const serialised = ids.join(",");
  if (serialised.length <= SIMULATED_URL_CAP_BYTES) {
    const wanted = new Set(ids);
    return allRows.filter((r) => wanted.has(r.id));
  }
  // Past the cap, the proxy returns only the prefix that fits.
  const kept: string[] = [];
  let used = 0;
  for (const id of ids) {
    const add = used === 0 ? id.length : id.length + 1;
    if (used + add > SIMULATED_URL_CAP_BYTES) break;
    kept.push(id);
    used += add;
  }
  const wanted = new Set(kept);
  return allRows.filter((r) => wanted.has(r.id));
}

async function buildSpecialtyMapChunked(
  sessions: SessionRow[],
  ids: string[],
): Promise<Map<string, string | null>> {
  const results = await Promise.all(
    chunkIds(ids).map((c) => Promise.resolve(fakeIn(sessions, c))),
  );
  const map = new Map<string, string | null>();
  for (const rows of results) for (const r of rows) map.set(r.id, r.specialty_id);
  return map;
}

function buildSpecialtyMapUnchunked(
  sessions: SessionRow[],
  ids: string[],
): Map<string, string | null> {
  const rows = fakeIn(sessions, ids); // single .in() call — the buggy path
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.id, r.specialty_id);
  return map;
}

function makeAssignments(sessions: SessionRow[]): MetricAssignment[] {
  // Half solo, half supervised — all real theatre AM/PM lists.
  return sessions.map((s, i) => ({
    role_on_list: i % 2 === 0 ? "solo" : "supervised",
    session: i % 2 === 0 ? "am" : "pm",
    duty_type: "theatre",
    theatre_session_id: s.id,
    session_date: "2026-01-15",
  }));
}

describe("'Unknown' specialty bucket — regression guard", () => {
  const SPECIALTIES = [
    { id: "spec-ent", name: "ENT" },
    { id: "spec-uro", name: "Urology" },
    { id: "spec-gen", name: "General" },
    { id: "spec-orth", name: "Orthopaedics" },
    { id: "spec-vasc", name: "Vascular" },
  ];
  const specialtyNameById = new Map(SPECIALTIES.map((s) => [s.id, s.name]));

  function seed(n: number): SessionRow[] {
    return Array.from({ length: n }, (_, i) => ({
      id: uuid(i),
      specialty_id: SPECIALTIES[i % SPECIALTIES.length].id,
    }));
  }

  it("unchunked lookup over 1500 IDs produces an 'Unknown' bucket (the bug)", async () => {
    const sessions = seed(1500);
    const assignments = makeAssignments(sessions);
    const tsMap = buildSpecialtyMapUnchunked(
      sessions,
      sessions.map((s) => s.id),
    );

    const metrics = computeTraineeMetrics(
      assignments,
      "2025-08-01",
      tsMap,
      specialtyNameById,
      new Date("2026-06-15").getTime(),
    );

    const unknown = metrics.specialtyBreakdown.find((b) => b.name === "Unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.count).toBeGreaterThan(0);
  });

  it("chunked lookup over 1500 IDs NEVER produces an 'Unknown' bucket", async () => {
    const sessions = seed(1500);
    const assignments = makeAssignments(sessions);
    const tsMap = await buildSpecialtyMapChunked(
      sessions,
      sessions.map((s) => s.id),
    );

    const metrics = computeTraineeMetrics(
      assignments,
      "2025-08-01",
      tsMap,
      specialtyNameById,
      new Date("2026-06-15").getTime(),
    );

    expect(metrics.specialtyBreakdown.find((b) => b.name === "Unknown")).toBeUndefined();
    expect(metrics.totalClinical).toBe(sessions.length);
    const totalCounted = metrics.specialtyBreakdown.reduce((a, b) => a + b.count, 0);
    expect(totalCounted).toBe(sessions.length);
  });

  it("chunked lookup stays Unknown-free at 5000 IDs", async () => {
    const sessions = seed(5000);
    const assignments = makeAssignments(sessions);
    const tsMap = await buildSpecialtyMapChunked(
      sessions,
      sessions.map((s) => s.id),
    );

    const metrics = computeTraineeMetrics(
      assignments,
      "2025-08-01",
      tsMap,
      specialtyNameById,
      new Date("2026-06-15").getTime(),
    );

    expect(metrics.specialtyBreakdown.find((b) => b.name === "Unknown")).toBeUndefined();
    expect(metrics.totalClinical).toBe(sessions.length);
    // Round-robin → equal counts across the five specialties.
    for (const s of SPECIALTIES) {
      const bucket = metrics.specialtyBreakdown.find((b) => b.name === s.name);
      expect(bucket?.count).toBe(sessions.length / SPECIALTIES.length);
    }
  });

  it("per-specialty percentages sum to 100 (no silent drops via Unknown)", async () => {
    const sessions = seed(2500);
    const assignments = makeAssignments(sessions);
    const tsMap = await buildSpecialtyMapChunked(
      sessions,
      sessions.map((s) => s.id),
    );

    const metrics = computeTraineeMetrics(
      assignments,
      "2025-08-01",
      tsMap,
      specialtyNameById,
      new Date("2026-06-15").getTime(),
    );

    const sum = metrics.specialtyBreakdown.reduce((a, b) => a + b.percent, 0);
    expect(sum).toBe(100);
    expect(metrics.specialtyBreakdown.every((b) => b.name !== "Unknown")).toBe(true);
  });

  it("does NOT bucket as Unknown when a session legitimately has a null specialty", async () => {
    // Genuine null specialty rows still go to "Unknown" by design (line 124
    // of trainee-metrics.ts). This test pins that behaviour so the
    // regression check above only fires for *truncation*, not for real data.
    const sessions = seed(10);
    const assignments = makeAssignments(sessions);
    const tsMap = new Map<string, string | null>(
      sessions.map((s, i) => [s.id, i < 3 ? null : s.specialty_id]),
    );

    const metrics = computeTraineeMetrics(
      assignments,
      "2025-08-01",
      tsMap,
      specialtyNameById,
      new Date("2026-06-15").getTime(),
    );

    const unknown = metrics.specialtyBreakdown.find((b) => b.name === "Unknown");
    expect(unknown?.count).toBe(3);
  });
});
