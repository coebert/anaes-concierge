import "@/test/assert-utc-hook";
import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";

/**
 * Regression for the "Dr S Tucker showed 300+ days since last annual leave"
 * bug. The admin wellbeing page used a single unordered `.range(0, 19999)`
 * against `leave_requests`. Supabase's Data API silently caps a single
 * response at db-max-rows (1000 on hosted projects), so recent approved
 * annual-leave rows that happened to sit past row 1000 in the underlying
 * order were dropped from the client's view. For Dr S Tucker the most recent
 * approved annual-leave row (a few weeks ago) fell outside the truncation
 * window, so the app fell back to an ~11-month-old spell and rendered
 * "300+ days since last annual leave".
 *
 * This test recreates that exact shape with a fixed fixture — Dr S Tucker
 * plus filler staff, with Tucker's recent approved annual leave placed after
 * the db-max-rows cap — and verifies:
 *   1. The paginated + ordered read surfaces Tucker's real recent leave
 *      dates (start_date + end_date), not the stale year-old spell.
 *   2. "Days since last annual leave" for Tucker is ~21, never >300.
 *   3. The legacy single unordered `.range()` reproduces the >300-day bug,
 *      locking in why the pagination fix is required.
 */

const DB_MAX_ROWS = 1000;
const TODAY = new Date("2026-07-10T00:00:00Z");
const DAY_MS = 86_400_000;

type Row = {
  id: string;
  staff_id: string;
  staff_name: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
};

function isoDaysAgo(days: number): string {
  return new Date(TODAY.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function makeFakeTable(rows: Row[]) {
  let orderKey: keyof Row | null = null;
  let ascending = true;
  const build = {
    order(key: keyof Row, opts: { ascending: boolean }) {
      orderKey = key;
      ascending = opts.ascending;
      return build;
    },
    async range(from: number, to: number) {
      const source = rows.slice();
      if (orderKey) {
        const k = orderKey;
        const dir = ascending ? 1 : -1;
        source.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir);
      }
      const cappedTo = Math.min(to, from + DB_MAX_ROWS - 1);
      return { data: source.slice(from, cappedTo + 1), error: null };
    },
  };
  return build;
}

function lastApprovedAnnual(staffId: string, leave: readonly Row[]): Row | null {
  return (
    leave
      .filter(
        (l) =>
          l.staff_id === staffId &&
          l.type === "annual" &&
          l.status === "approved",
      )
      .sort((a, b) => b.end_date.localeCompare(a.end_date))[0] ?? null
  );
}

function daysSince(iso: string): number {
  return Math.floor((TODAY.getTime() - new Date(iso).getTime()) / DAY_MS);
}

/**
 * Fixed fixture. Dr S Tucker has:
 *   - a real recent approved annual leave 21..15 days ago (what he actually
 *     took a few weeks before the observed bug),
 *   - a much older approved annual leave 330 days ago (the spell the app was
 *     incorrectly surfacing as "last annual leave"),
 *   - assorted rejected/other-type spells that shouldn't count.
 * Filler rows for other staff pad the table well past the 1000-row cap and
 * are ordered so Tucker's recent row lands AFTER the cap in the physical
 * (unordered) read — reproducing the silent truncation.
 */
function buildFixture() {
  const TUCKER = { id: "staff-tucker", name: "Dr S Tucker" };
  const fillerStaff = Array.from({ length: 20 }, (_, i) => ({
    id: `staff-filler-${i}`,
    name: `Filler ${i}`,
  }));
  const rows: Row[] = [];
  let counter = 0;
  const push = (r: Omit<Row, "id">) =>
    rows.push({ id: `r-${counter++}`, ...r });

  // Tucker's OLD approved annual leave — 330 days ago. This is the row the
  // buggy read surfaced as "last annual leave".
  push({
    staff_id: TUCKER.id,
    staff_name: TUCKER.name,
    type: "annual",
    status: "approved",
    start_date: isoDaysAgo(337),
    end_date: isoDaysAgo(330),
  });

  // Noise for other staff to push past the db-max-rows cap.
  while (rows.length < 1500) {
    const s = fillerStaff[rows.length % fillerStaff.length];
    const daysAgo = 200 + (rows.length % 400);
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: "annual",
      status: "approved",
      start_date: isoDaysAgo(daysAgo + 5),
      end_date: isoDaysAgo(daysAgo),
    });
  }

  // Tucker's REAL recent approved annual leave — 21..15 days ago. Placed
  // AFTER the cap on purpose, and interleaved with a couple of red herrings.
  push({
    staff_id: TUCKER.id,
    staff_name: TUCKER.name,
    type: "annual",
    status: "rejected",
    start_date: isoDaysAgo(10),
    end_date: isoDaysAgo(8),
  });
  push({
    staff_id: TUCKER.id,
    staff_name: TUCKER.name,
    type: "study",
    status: "approved",
    start_date: isoDaysAgo(45),
    end_date: isoDaysAgo(43),
  });
  push({
    staff_id: TUCKER.id,
    staff_name: TUCKER.name,
    type: "annual",
    status: "approved",
    start_date: isoDaysAgo(21),
    end_date: isoDaysAgo(15),
  });

  return { tucker: TUCKER, rows };
}

describe("Dr S Tucker 300+ days regression", () => {
  it("paginated + ordered read surfaces Tucker's real recent annual leave dates", async () => {
    const { tucker, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );

    expect(fetched.length).toBe(rows.length);

    const last = lastApprovedAnnual(tucker.id, fetched);
    expect(last).not.toBeNull();
    // The correct spell — a few weeks ago — must be picked.
    expect(last!.start_date).toBe(isoDaysAgo(21));
    expect(last!.end_date).toBe(isoDaysAgo(15));
    expect(daysSince(last!.end_date)).toBe(15);
    expect(daysSince(last!.end_date)).toBeLessThan(90);
  });

  it("legacy single unordered .range(0, 19999) reproduces the >300 day inflation", async () => {
    const { tucker, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const { data, error } = await table.range(0, 19999);
    expect(error).toBeNull();
    // Silent truncation to DB_MAX_ROWS — the exact mechanism behind the bug.
    expect(data.length).toBe(DB_MAX_ROWS);

    const last = lastApprovedAnnual(tucker.id, data);
    expect(last).not.toBeNull();
    // Under the legacy path only the 330-days-ago spell is visible, so the
    // page rendered "300+ days since last annual leave" for Dr S Tucker.
    expect(last!.end_date).toBe(isoDaysAgo(330));
    expect(daysSince(last!.end_date)).toBeGreaterThan(300);
  });

  it("paginated read is stable across page boundaries (Tucker's recent row is not on the first page)", async () => {
    const { tucker, rows } = buildFixture();
    const table = makeFakeTable(rows);

    // Sanity: without ordering, Tucker's recent approved annual sits past
    // row 1000 — otherwise the fixture wouldn't reproduce the bug.
    const { data: firstPageUnordered } = await table.range(0, DB_MAX_ROWS - 1);
    const recentOnFirstPage = firstPageUnordered.some(
      (r) =>
        r.staff_id === tucker.id &&
        r.type === "annual" &&
        r.status === "approved" &&
        r.end_date === isoDaysAgo(15),
    );
    expect(recentOnFirstPage).toBe(false);

    // With `.order('end_date', desc)` + pagination, the recent row is now
    // on page 1 (newest first), and the full fetch matches the fixture.
    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    const tuckerApproved = fetched.filter(
      (r) =>
        r.staff_id === tucker.id &&
        r.type === "annual" &&
        r.status === "approved",
    );
    expect(tuckerApproved.map((r) => r.end_date)).toEqual([
      isoDaysAgo(15),
      isoDaysAgo(330),
    ]);
  });
});
