import "@/test/assert-utc-hook";
import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";

/**
 * Regression: the admin wellbeing / attrition page used to fetch
 * `leave_requests` with a single unordered `.range(0, 19999)`. Supabase's
 * Data API caps a single response at db-max-rows (1000 on hosted projects),
 * so it silently returned the first 1000 rows in an undefined order. Recent
 * approved annual-leave rows for individual staff could fall outside that
 * window, and "days since last annual leave" would then be computed against
 * a much older spell — inflating the number to >300 days for staff who had
 * actually taken leave weeks ago (observed for Dr S Tucker).
 *
 * This suite locks in the fix by simulating a >1000-row dataset with the
 * PostgREST cap enforced, and asserting that the paginated + ordered read
 * path (`fetchAllPaged` + `.order('end_date', { ascending: false })`)
 * produces the correct "days since last annual leave" for every staff
 * member, while the legacy unpaginated read path does not.
 */

const DB_MAX_ROWS = 1000; // matches Supabase Data API default cap
const TODAY = new Date("2026-07-10T00:00:00Z");
const DAY_MS = 86_400_000;

type Row = {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  end_date: string;
};

/**
 * Build a simulated PostgREST builder over an in-memory row set. It honours
 * `.order()` and enforces the db-max-rows cap so a single wide `.range()`
 * can't read more than DB_MAX_ROWS rows in one call — the exact silent
 * truncation that caused the original bug.
 */
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
      let source = rows.slice();
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

function isoDaysAgo(days: number): string {
  return new Date(TODAY.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Same "days since last annual leave" calc the attrition rubric uses.
 */
function daysSinceLastAnnual(
  staffId: string,
  leave: readonly Row[],
): number | null {
  const approvedAnnual = leave
    .filter(
      (l) => l.staff_id === staffId && l.type === "annual" && l.status === "approved",
    )
    .sort((a, b) => b.end_date.localeCompare(a.end_date));
  if (!approvedAnnual[0]) return null;
  const end = new Date(approvedAnnual[0].end_date).getTime();
  return Math.max(0, Math.floor((TODAY.getTime() - end) / DAY_MS));
}

/**
 * 5 staff, 2500 leave rows total. Every staff has one "recent" approved
 * annual-leave row (14 days ago) that must be surfaced. The remaining rows
 * are old, rejected, cancelled, or unrelated types — plausible noise that
 * bloats the table past the db-max-rows cap.
 */
function buildDataset() {
  const staffIds = ["staff-a", "staff-b", "staff-c", "staff-d", "staff-e"];
  const rows: Row[] = [];
  let counter = 0;
  const push = (r: Omit<Row, "id">) =>
    rows.push({ id: `r-${counter++}`, ...r });
  const recent: Row[] = [];
  const pushRecent = (r: Omit<Row, "id">) =>
    recent.push({ id: `r-${counter++}`, ...r });

  // Recent approved annual leave for every staff member — held aside and
  // placed AFTER the db-max-rows cap so the legacy unordered read drops them.
  for (const s of staffIds) {
    pushRecent({
      staff_id: s,
      type: "annual",
      status: "approved",
      end_date: isoDaysAgo(14),
    });
  }

  // Fill up to well past the 1000-row cap with older / noise rows.
  while (rows.length < 2500) {
    const s = staffIds[rows.length % staffIds.length];
    const daysAgo = 400 + (rows.length % 600); // all older than a year
    const kind = rows.length % 4;
    if (kind === 0) {
      push({ staff_id: s, type: "annual", status: "approved", end_date: isoDaysAgo(daysAgo) });
    } else if (kind === 1) {
      push({ staff_id: s, type: "annual", status: "rejected", end_date: isoDaysAgo(daysAgo) });
    } else if (kind === 2) {
      push({ staff_id: s, type: "sick", status: "approved", end_date: isoDaysAgo(daysAgo) });
    } else {
      push({ staff_id: s, type: "study", status: "approved", end_date: isoDaysAgo(daysAgo) });
    }
  }

  // Recent rows go at the tail so, without .order(), a range(0, 999) read
  // never sees them — exactly the silent truncation the fix must handle.
  rows.push(...recent);
  return { staffIds, rows };
}

describe("wellbeing 'days since last annual leave' — regression", () => {
  it("surfaces recent approved annual leave for every staff member via the paginated + ordered read", async () => {
    const { staffIds, rows } = buildDataset();
    const table = makeFakeTable(rows);

    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );

    expect(fetched.length).toBe(rows.length);
    // Ordered fetch: the newest end_date wins the sort → each staff's
    // "14 days ago" annual leave row must be present.
    for (const s of staffIds) {
      expect(daysSinceLastAnnual(s, fetched)).toBe(14);
    }
  });

  it("legacy single unordered .range(0, 19999) drops the recent rows (locks in why we paginate)", async () => {
    const { staffIds, rows } = buildDataset();
    const table = makeFakeTable(rows);

    // No .order(); one wide range like the code shipped before the fix.
    const { data, error } = await table.range(0, 19999);
    expect(error).toBeNull();
    // The cap silently truncates to DB_MAX_ROWS regardless of the caller's
    // ask — this is the mechanism that caused the >300 day inflation.
    expect(data.length).toBe(DB_MAX_ROWS);

    // At least one staff member's "days since last annual leave" is wrong
    // (either inflated well past 14 days, or null) under the legacy path.
    const wrong = staffIds.filter((s) => {
      const d = daysSinceLastAnnual(s, data);
      return d === null || d > 14;
    });
    expect(wrong.length).toBeGreaterThan(0);
  });

  it("paginated read stays correct even when the dataset grows past several page boundaries", async () => {
    const { staffIds } = buildDataset();
    // Amplify: 6000 rows, still one recent approved annual per staff.
    const rows: Row[] = [];
    let counter = 0;
    for (const s of staffIds) {
      rows.push({
        id: `r-${counter++}`,
        staff_id: s,
        type: "annual",
        status: "approved",
        end_date: isoDaysAgo(21),
      });
    }
    while (rows.length < 6000) {
      const s = staffIds[rows.length % staffIds.length];
      rows.push({
        id: `r-${counter++}`,
        staff_id: s,
        type: "annual",
        status: "approved",
        end_date: isoDaysAgo(500 + (rows.length % 500)),
      });
    }

    const table = makeFakeTable(rows);
    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    expect(fetched.length).toBe(rows.length);
    for (const s of staffIds) {
      expect(daysSinceLastAnnual(s, fetched)).toBe(21);
    }
  });
});
