import { describe, it, expect } from "vitest";
import { chunkIds, SUPABASE_IN_CHUNK } from "./supabase-chunked";

/**
 * Regression test for the `/trainees` overview and `admin.dashboard`
 * specialty-counting bug.
 *
 * The PostgREST edge proxy silently truncates responses when the request
 * URL exceeds roughly 16 KB. A `.in("id", uuids)` call with ~400+ UUIDs
 * triggers that limit; rows past the cutoff disappear from the result set
 * and downstream code buckets them as "Unknown" specialty.
 *
 * Both `/trainees` and `admin.dashboard` now route theatre-session lookups
 * through {@link chunkIds} with `SUPABASE_IN_CHUNK = 200`. This test seeds
 * a large pool of theatre sessions, simulates the proxy cap, and proves
 * (a) a single unchunked `.in()` would drop rows, and (b) the chunked
 * pattern recovers every row so per-specialty counts are exact.
 */

// Simulated edge-proxy URL cap. 36 chars per UUID + 1 for the comma ≈ 37 B.
// 400 UUIDs ≈ 14.8 KB of just the id list, which is where real-world
// truncation kicks in. Use a conservative 12 KB here.
const SIMULATED_URL_CAP_BYTES = 12_000;

type Row = { id: string; specialty_id: string };

function uuid(i: number): string {
  // Stable, valid-shaped UUIDs (length 36 incl. dashes) so the byte budget
  // matches production.
  const hex = i.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function seedSessions(n: number, specialties: string[]): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(i),
    specialty_id: specialties[i % specialties.length],
  }));
}

/**
 * Mimics PostgREST `.from("theatre_sessions").select(...).in("id", ids)`
 * with the edge proxy's URL-length cap. When the serialised id list
 * exceeds the cap, the response is truncated to whatever fits — exactly
 * the silent failure mode we hit in production.
 */
function fakeIn(allRows: Row[], ids: readonly string[]): Row[] {
  const serialised = ids.join(",");
  if (serialised.length <= SIMULATED_URL_CAP_BYTES) {
    const wanted = new Set(ids);
    return allRows.filter((r) => wanted.has(r.id));
  }
  // Past the cap, the proxy keeps only the prefix of ids that fits.
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

async function fetchSpecialtiesChunked(
  allRows: Row[],
  ids: string[],
): Promise<Map<string, string | null>> {
  const chunks = chunkIds(ids);
  const results = await Promise.all(chunks.map((c) => Promise.resolve(fakeIn(allRows, c))));
  const map = new Map<string, string | null>();
  for (const rows of results) {
    for (const r of rows) map.set(r.id, r.specialty_id);
  }
  return map;
}

describe("theatre-session bulk lookup — chunking prevents truncation", () => {
  const SPECIALTIES = ["ent", "uro", "gen", "ortho", "vasc"];

  it("chunk size keeps each request URL well under the proxy cap", () => {
    // 200 UUIDs × 37 B ≈ 7.4 KB — comfortably below the 12 KB simulated cap
    // and the real ~16 KB edge limit.
    const ids = Array.from({ length: SUPABASE_IN_CHUNK }, (_, i) => uuid(i));
    expect(ids.join(",").length).toBeLessThan(SIMULATED_URL_CAP_BYTES);
  });

  it("a single unchunked .in() over 1500 IDs SILENTLY drops rows (the bug we fixed)", () => {
    const sessions = seedSessions(1500, SPECIALTIES);
    const ids = sessions.map((s) => s.id);
    const naive = fakeIn(sessions, ids);
    // Proves the failure mode exists in the simulator.
    expect(naive.length).toBeLessThan(sessions.length);
    expect(ids.join(",").length).toBeGreaterThan(SIMULATED_URL_CAP_BYTES);
  });

  it("chunked lookup returns EVERY theatre-session specialty for 1500 IDs", async () => {
    const sessions = seedSessions(1500, SPECIALTIES);
    const ids = sessions.map((s) => s.id);

    const tsMap = await fetchSpecialtiesChunked(sessions, ids);

    expect(tsMap.size).toBe(sessions.length);
    for (const s of sessions) {
      expect(tsMap.get(s.id)).toBe(s.specialty_id);
    }
  });

  it("per-specialty counts (as used by /trainees + admin.dashboard cards) are exact", async () => {
    const sessions = seedSessions(1500, SPECIALTIES);
    const ids = sessions.map((s) => s.id);

    const tsMap = await fetchSpecialtiesChunked(sessions, ids);

    // Replicate the bucketing both pages do: assignments → theatre_session →
    // specialty_id. Every ID must resolve; no "Unknown" bucket.
    const counts = new Map<string, number>();
    let unknown = 0;
    for (const id of ids) {
      const spec = tsMap.get(id);
      if (!spec) {
        unknown += 1;
        continue;
      }
      counts.set(spec, (counts.get(spec) ?? 0) + 1);
    }

    expect(unknown).toBe(0);
    // 1500 IDs spread round-robin across 5 specialties → 300 each.
    for (const spec of SPECIALTIES) {
      expect(counts.get(spec)).toBe(300);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(sessions.length);
  });

  it("scales to 5000 IDs without truncation or dropped specialties", async () => {
    const sessions = seedSessions(5000, SPECIALTIES);
    const ids = sessions.map((s) => s.id);

    const tsMap = await fetchSpecialtiesChunked(sessions, ids);

    expect(tsMap.size).toBe(sessions.length);
    // Chunk count is ceil(5000 / 200) = 25.
    expect(chunkIds(ids).length).toBe(25);
  });

  it("handles an exact multiple of the chunk size with no off-by-one", async () => {
    const sessions = seedSessions(SUPABASE_IN_CHUNK * 4, SPECIALTIES);
    const ids = sessions.map((s) => s.id);
    const tsMap = await fetchSpecialtiesChunked(sessions, ids);
    expect(tsMap.size).toBe(sessions.length);
    expect(chunkIds(ids).every((c) => c.length === SUPABASE_IN_CHUNK)).toBe(true);
  });

  it("handles a non-multiple (tail chunk smaller than 200) correctly", async () => {
    const sessions = seedSessions(SUPABASE_IN_CHUNK * 3 + 17, SPECIALTIES);
    const ids = sessions.map((s) => s.id);
    const tsMap = await fetchSpecialtiesChunked(sessions, ids);
    expect(tsMap.size).toBe(sessions.length);
    const chunks = chunkIds(ids);
    expect(chunks.length).toBe(4);
    expect(chunks[chunks.length - 1].length).toBe(17);
  });
});
