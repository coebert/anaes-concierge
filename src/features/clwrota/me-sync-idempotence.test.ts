import { describe, it, expect } from "vitest";
import { sessionsCoveredByTimeRange } from "./parsing";

/**
 * Idempotence contract for medical_examiner AM/PM assignments.
 *
 * Reality being modelled:
 *   - CLWRota emits a single all-day ME row (08:00–17:00) with one
 *     `external_id`. The sync splits it into two drafts whose ids are
 *     suffixed `|am` / `|pm` so both halves can persist under the
 *     UNIQUE (clwrota_external_id) constraint.
 *   - `rota_assignments` also has UNIQUE (staff_id, session_date, session).
 *     If a re-sync ran BEFORE the split logic existed, an un-suffixed
 *     legacy row (session='am' typically) may already exist. Without a
 *     pre-upsert purge, the two suffixed inserts would either duplicate
 *     the day's ME coverage (three rows for two halves) or trip the
 *     no-double-booking constraint on insert.
 *
 * This test models the same in-memory store shape used by other sync
 * integration tests (UNIQUE on clwrota_external_id AND on
 * (staff_id, session_date, session)) and asserts:
 *   - a second sync over the same CLWRota row does not create duplicates
 *   - a legacy un-suffixed ME row is cleaned up before the upsert
 *   - locally-modified rows are never purged, even if a suffixed sibling exists
 */

type Row = {
  staff_id: string;
  session_date: string;
  session: "am" | "pm";
  duty_type: string;
  clwrota_external_id: string;
  locally_modified: boolean;
  source: "clwrota" | "manual";
};

function makeStore() {
  const rows: Row[] = [];
  const seed = (r: Row) => rows.push({ ...r });
  const purgeSplitParents = (parentIds: Set<string>) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (
        r.duty_type === "medical_examiner" &&
        !r.locally_modified &&
        parentIds.has(r.clwrota_external_id)
      ) {
        rows.splice(i, 1);
      }
    }
  };
  const upsert = (incoming: Row) => {
    // UNIQUE (staff_id, session_date, session)
    const slotClash = rows.find(
      (r) =>
        r.staff_id === incoming.staff_id &&
        r.session_date === incoming.session_date &&
        r.session === incoming.session &&
        r.clwrota_external_id !== incoming.clwrota_external_id,
    );
    if (slotClash) {
      throw new Error(
        `unique_violation: (${incoming.staff_id}, ${incoming.session_date}, ${incoming.session}) already occupied by ${slotClash.clwrota_external_id}`,
      );
    }
    // UNIQUE (clwrota_external_id) — upsert
    const existing = rows.findIndex(
      (r) => r.clwrota_external_id === incoming.clwrota_external_id,
    );
    if (existing >= 0) rows[existing] = { ...incoming };
    else rows.push({ ...incoming });
  };
  return { rows, seed, upsert, purgeSplitParents };
}

/** Emulates the sync's ME draft-generation contract. */
function buildMeDrafts(input: {
  externalId: string;
  staffId: string;
  date: string;
  startTime: string;
  endTime: string;
  originalSession: "am" | "pm";
}): { drafts: Row[]; splitParents: Set<string> } {
  const covered = sessionsCoveredByTimeRange(input.startTime, input.endTime);
  const halves = covered.length > 0 ? covered : [input.originalSession];
  const isSplit = halves.length > 1;
  const splitParents = new Set<string>();
  if (isSplit) splitParents.add(input.externalId);
  const drafts: Row[] = halves.map((half) => ({
    staff_id: input.staffId,
    session_date: input.date,
    session: half,
    duty_type: "medical_examiner",
    clwrota_external_id: isSplit ? `${input.externalId}|${half}` : input.externalId,
    locally_modified: false,
    source: "clwrota",
  }));
  return { drafts, splitParents };
}

function runSync(
  store: ReturnType<typeof makeStore>,
  drafts: Row[],
  splitParents: Set<string>,
) {
  store.purgeSplitParents(splitParents);
  for (const d of drafts) store.upsert(d);
}

const INPUT = {
  externalId: "clwrota-me-2026-06-10-alice",
  staffId: "alice",
  date: "2026-06-10",
  startTime: "08:00",
  endTime: "17:00",
  originalSession: "am" as const,
};

describe("medical_examiner AM/PM sync idempotence", () => {
  it("splits an all-day ME row into exactly two rows on first sync", () => {
    const store = makeStore();
    const { drafts, splitParents } = buildMeDrafts(INPUT);
    runSync(store, drafts, splitParents);

    expect(store.rows).toHaveLength(2);
    expect(store.rows.map((r) => r.session).sort()).toEqual(["am", "pm"]);
    expect(store.rows.map((r) => r.clwrota_external_id).sort()).toEqual([
      `${INPUT.externalId}|am`,
      `${INPUT.externalId}|pm`,
    ]);
  });

  it("re-syncing the same CLWRota row does not create duplicates", () => {
    const store = makeStore();
    const first = buildMeDrafts(INPUT);
    runSync(store, first.drafts, first.splitParents);

    const second = buildMeDrafts(INPUT);
    runSync(store, second.drafts, second.splitParents);

    expect(store.rows).toHaveLength(2);
    expect(store.rows.filter((r) => r.session === "am")).toHaveLength(1);
    expect(store.rows.filter((r) => r.session === "pm")).toHaveLength(1);
  });

  it("cleans up a legacy un-suffixed ME row from a pre-split sync", () => {
    const store = makeStore();
    // Legacy: a previous sync (before the split logic) persisted the raw row
    store.seed({
      staff_id: INPUT.staffId,
      session_date: INPUT.date,
      session: "am",
      duty_type: "medical_examiner",
      clwrota_external_id: INPUT.externalId,
      locally_modified: false,
      source: "clwrota",
    });

    const { drafts, splitParents } = buildMeDrafts(INPUT);
    // Without the purge this would trip the (staff,date,session) UNIQUE
    // constraint. `runSync` must not throw.
    expect(() => runSync(store, drafts, splitParents)).not.toThrow();

    expect(store.rows).toHaveLength(2);
    expect(store.rows.some((r) => r.clwrota_external_id === INPUT.externalId)).toBe(false);
    expect(store.rows.map((r) => r.clwrota_external_id).sort()).toEqual([
      `${INPUT.externalId}|am`,
      `${INPUT.externalId}|pm`,
    ]);
  });

  it("never purges a locally-modified un-suffixed ME row (coordinator edit wins)", () => {
    const store = makeStore();
    store.seed({
      staff_id: INPUT.staffId,
      session_date: INPUT.date,
      session: "am",
      duty_type: "medical_examiner",
      clwrota_external_id: INPUT.externalId,
      locally_modified: true,
      source: "clwrota",
    });

    const { drafts, splitParents } = buildMeDrafts(INPUT);
    // The locally-modified AM row must survive; the AM half from the split
    // would clash with it under (staff,date,session), so the sync must skip
    // the AM half. We simulate the production behaviour of skipping any
    // half whose slot is already held by a locked row.
    store.purgeSplitParents(splitParents);
    for (const d of drafts) {
      const locked = store.rows.find(
        (r) =>
          r.locally_modified &&
          r.staff_id === d.staff_id &&
          r.session_date === d.session_date &&
          r.session === d.session,
      );
      if (locked) continue;
      store.upsert(d);
    }

    const legacyAm = store.rows.find(
      (r) => r.clwrota_external_id === INPUT.externalId,
    );
    expect(legacyAm).toBeDefined();
    expect(legacyAm?.locally_modified).toBe(true);
    // The PM half still lands as a suffixed row
    expect(
      store.rows.some((r) => r.clwrota_external_id === `${INPUT.externalId}|pm`),
    ).toBe(true);
  });

  it("does not touch un-related ME rows on re-sync", () => {
    const store = makeStore();
    const other: Row = {
      staff_id: "bob",
      session_date: "2026-06-11",
      session: "am",
      duty_type: "medical_examiner",
      clwrota_external_id: "clwrota-me-other|am",
      locally_modified: false,
      source: "clwrota",
    };
    store.seed(other);

    const { drafts, splitParents } = buildMeDrafts(INPUT);
    runSync(store, drafts, splitParents);

    expect(
      store.rows.find((r) => r.clwrota_external_id === "clwrota-me-other|am"),
    ).toEqual(other);
  });
});
