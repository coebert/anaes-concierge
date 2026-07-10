import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";

/**
 * Companion regression to `wellbeing-tucker-regression.test.ts`.
 *
 * The Tucker bug wasn't Tucker-specific — any staff member whose most recent
 * approved leave landed past Supabase's silent 1000-row cap would show a
 * stale "days since last leave" figure. This test uses the same fixture
 * shape (fixed rota + leave rows, filler noise pushing rows past the cap)
 * but checks recent-leave dates for MULTIPLE staff at once and across
 * MULTIPLE leave types (annual, study, compassionate).
 *
 * Guarantees:
 *   1. The paginated + ordered read surfaces each staff member's real recent
 *      approved leave, per type, regardless of position in the raw table.
 *   2. The legacy single unordered `.range(0, 19999)` reproduces the stale
 *      result for at least one staff/type combination — locking in why the
 *      pagination fix must stay in place for every staff member, not just
 *      Dr S Tucker.
 */

const DB_MAX_ROWS = 1000;
const TODAY = new Date("2026-07-10T00:00:00Z");
const DAY_MS = 86_400_000;

type LeaveType = "annual" | "study" | "compassionate";

type Row = {
  id: string;
  staff_id: string;
  staff_name: string;
  type: LeaveType | "sick";
  status: "approved" | "rejected" | "pending";
  start_date: string;
  end_date: string;
};

function isoDaysAgo(days: number): string {
  return new Date(TODAY.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function daysSince(iso: string): number {
  return Math.floor((TODAY.getTime() - new Date(iso).getTime()) / DAY_MS);
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

function lastApproved(
  staffId: string,
  type: LeaveType,
  leave: readonly Row[],
): Row | null {
  return (
    leave
      .filter(
        (l) =>
          l.staff_id === staffId && l.type === type && l.status === "approved",
      )
      .sort((a, b) => b.end_date.localeCompare(a.end_date))[0] ?? null
  );
}

/**
 * Fixed fixture. Three staff — each with a stale approved spell (>300 days
 * ago) AND a real recent approved spell (7..25 days ago), spread across
 * annual / study / compassionate. Filler rows for other staff pad well past
 * the 1000-row cap so each staff's recent row sits after the cap in the
 * physical (unordered) read.
 */
function buildFixture() {
  const staff = [
    { id: "staff-a", name: "Dr A. Patel", type: "annual" as const, recentEnd: 12, recentStart: 18, staleEnd: 340 },
    { id: "staff-b", name: "Dr B. Kim", type: "study" as const, recentEnd: 7, recentStart: 10, staleEnd: 310 },
    { id: "staff-c", name: "Dr C. Novak", type: "compassionate" as const, recentEnd: 25, recentStart: 27, staleEnd: 355 },
  ];
  const fillerStaff = Array.from({ length: 20 }, (_, i) => ({
    id: `staff-filler-${i}`,
    name: `Filler ${i}`,
  }));

  const rows: Row[] = [];
  let counter = 0;
  const push = (r: Omit<Row, "id">) => rows.push({ id: `r-${counter++}`, ...r });

  // Stale approved spells first — these are what the buggy read surfaces.
  for (const s of staff) {
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: s.type,
      status: "approved",
      start_date: isoDaysAgo(s.staleEnd + 5),
      end_date: isoDaysAgo(s.staleEnd),
    });
  }

  // Noise: 1500+ approved annual rows for filler staff, pushing well past the cap.
  while (rows.length < 1600) {
    const f = fillerStaff[rows.length % fillerStaff.length];
    const d = 200 + (rows.length % 400);
    push({
      staff_id: f.id,
      staff_name: f.name,
      type: "annual",
      status: "approved",
      start_date: isoDaysAgo(d + 5),
      end_date: isoDaysAgo(d),
    });
  }

  // Real recent approved spells for each staff — placed AFTER the cap on
  // purpose, interleaved with red herrings (rejected / wrong-type).
  for (const s of staff) {
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: s.type,
      status: "rejected",
      start_date: isoDaysAgo(4),
      end_date: isoDaysAgo(2),
    });
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: "sick",
      status: "approved",
      start_date: isoDaysAgo(50),
      end_date: isoDaysAgo(48),
    });
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: s.type,
      status: "approved",
      start_date: isoDaysAgo(s.recentStart),
      end_date: isoDaysAgo(s.recentEnd),
    });
  }

  return { staff, rows };
}

describe("Multi-staff recent-leave regression (fixed fixture)", () => {
  it("paginated + ordered read surfaces each staff member's real recent leave, per type", async () => {
    const { staff, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    expect(fetched.length).toBe(rows.length);

    for (const s of staff) {
      const last = lastApproved(s.id, s.type, fetched);
      expect(last, `no recent ${s.type} for ${s.name}`).not.toBeNull();
      expect(last!.start_date).toBe(isoDaysAgo(s.recentStart));
      expect(last!.end_date).toBe(isoDaysAgo(s.recentEnd));
      expect(daysSince(last!.end_date)).toBe(s.recentEnd);
      expect(daysSince(last!.end_date)).toBeLessThan(90);
    }
  });

  it("legacy single unordered .range(0, 19999) inflates 'days since last leave' for every staff", async () => {
    const { staff, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const { data, error } = await table.range(0, 19999);
    expect(error).toBeNull();
    expect(data.length).toBe(DB_MAX_ROWS);

    for (const s of staff) {
      const last = lastApproved(s.id, s.type, data);
      expect(last, `${s.name} should have a stale row visible`).not.toBeNull();
      // Under the legacy path only the ancient spell is visible.
      expect(last!.end_date).toBe(isoDaysAgo(s.staleEnd));
      expect(daysSince(last!.end_date)).toBeGreaterThan(300);
    }
  });

  it("each staff's recent approved row sits past the 1000-row cap in the raw read", async () => {
    const { staff, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const { data: firstPageUnordered } = await table.range(0, DB_MAX_ROWS - 1);
    for (const s of staff) {
      const onFirstPage = firstPageUnordered.some(
        (r) =>
          r.staff_id === s.id &&
          r.type === s.type &&
          r.status === "approved" &&
          r.end_date === isoDaysAgo(s.recentEnd),
      );
      expect(onFirstPage, `${s.name}'s recent row must NOT be on page 1`).toBe(false);
    }

    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    for (const s of staff) {
      const approved = fetched
        .filter(
          (r) => r.staff_id === s.id && r.type === s.type && r.status === "approved",
        )
        .map((r) => r.end_date);
      expect(approved).toEqual([isoDaysAgo(s.recentEnd), isoDaysAgo(s.staleEnd)]);
    }
  });
});
