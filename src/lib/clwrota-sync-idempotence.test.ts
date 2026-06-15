import { describe, it, expect } from "vitest";

/**
 * Idempotence guard for CLWRota sync writes.
 *
 * The sync pipeline upserts theatre_sessions and rota_assignments against
 * real UNIQUE constraints, so rerunning a 12-month window cannot insert
 * duplicate rows:
 *   - theatre_sessions: UNIQUE (session_date, theatre_id, session)
 *   - rota_assignments: UNIQUE (clwrota_external_id)
 *
 * The second risk is "mapping corruption": a rerun whose feed temporarily
 * lacks a consultant name or a specialty must NOT blank out the prior
 * value. The sync bucket-splits drafts by which optional columns it has,
 * so any column we don't have a fresh non-null value for is omitted from
 * the upsert payload and the previous DB value survives the ON CONFLICT
 * UPDATE.
 *
 * This test models that contract end-to-end against an in-memory store
 * that enforces the same UNIQUE constraints and the same omit-to-preserve
 * semantics PostgREST gives us.
 */

type SessionRow = {
  id: string;
  session_date: string;
  theatre_id: string;
  session: "am" | "pm";
  specialty_id: string | null;
  surgical_consultant: string | null;
  is_non_sag: boolean;
  non_sag_override: boolean;
};

type AssignmentRow = {
  id: string;
  staff_id: string;
  session_date: string;
  session: "am" | "pm";
  duty_type: string;
  role_on_list: string;
  theatre_session_id: string | null;
  clwrota_external_id: string;
  locally_modified: boolean;
};

type Draft = {
  session_date: string;
  theatre_id: string;
  session: "am" | "pm";
  specialty_id: string | null;
  surgical_consultant: string | null;
};

type AsgDraft = Omit<AssignmentRow, "id" | "locally_modified">;

function makeStore() {
  const sessions: SessionRow[] = [];
  const assignments: AssignmentRow[] = [];
  let nextId = 1;
  const newId = () => `id-${nextId++}`;
  const sessionKey = (r: { session_date: string; theatre_id: string; session: string }) =>
    `${r.session_date}|${r.theatre_id}|${r.session}`;

  /** Upsert a bucket of rows sharing the same column shape. Omitted
   * columns are NOT touched on conflict — the PostgREST semantic. */
  const upsertSessions = (rows: Array<Partial<SessionRow>>) => {
    if (rows.length === 0) return;
    const columns = new Set(Object.keys(rows[0]));
    const existing = new Map(sessions.map((s) => [sessionKey(s), s] as const));
    for (const r of rows) {
      const key = sessionKey(r as { session_date: string; theatre_id: string; session: string });
      const prior = existing.get(key);
      if (prior) {
        for (const col of columns) {
          if (col === "session_date" || col === "theatre_id" || col === "session") continue;
          (prior as Record<string, unknown>)[col] = (r as Record<string, unknown>)[col];
        }
      } else {
        sessions.push({
          id: newId(),
          session_date: r.session_date!,
          theatre_id: r.theatre_id!,
          session: r.session!,
          specialty_id: columns.has("specialty_id") ? r.specialty_id ?? null : null,
          surgical_consultant: columns.has("surgical_consultant") ? r.surgical_consultant ?? null : null,
          is_non_sag: false,
          non_sag_override: false,
        });
      }
    }
  };

  const upsertAssignments = (rows: AsgDraft[]) => {
    const existing = new Map(assignments.map((a) => [a.clwrota_external_id, a] as const));
    for (const r of rows) {
      const prior = existing.get(r.clwrota_external_id);
      if (prior) {
        if (prior.locally_modified) continue; // skipped by sync
        Object.assign(prior, r);
      } else {
        assignments.push({ id: newId(), locally_modified: false, ...r });
      }
    }
  };

  /** Mirror the production bucket split — omit columns we have no fresh
   * non-null value for, so the UPDATE side of ON CONFLICT leaves the
   * prior DB value intact. */
  const runSync = (drafts: Draft[], asgDrafts: AsgDraft[]) => {
    const buckets = new Map<string, Array<Partial<SessionRow>>>();
    for (const d of drafts) {
      const base: Partial<SessionRow> = {
        session_date: d.session_date,
        theatre_id: d.theatre_id,
        session: d.session,
      };
      if (d.specialty_id != null) base.specialty_id = d.specialty_id;
      if (d.surgical_consultant != null) base.surgical_consultant = d.surgical_consultant;
      const key = `${d.specialty_id != null ? "S" : "_"}${d.surgical_consultant != null ? "C" : "_"}`;
      (buckets.get(key) ?? (buckets.set(key, []), buckets.get(key)!)).push(base);
    }
    for (const key of ["SC", "S_", "_C", "__"]) {
      const rows = buckets.get(key);
      if (rows) upsertSessions(rows);
    }

    // Resolve theatre_session_id from the now-current sessions list.
    const byKey = new Map(sessions.map((s) => [sessionKey(s), s.id] as const));
    upsertAssignments(
      asgDrafts.map((a) => ({
        ...a,
        theatre_session_id:
          a.theatre_session_id /* already resolved */ ??
          (a as unknown as { _key?: string })._key
            ? byKey.get((a as unknown as { _key: string })._key) ?? null
            : null,
      })),
    );
  };

  return { sessions, assignments, runSync };
}

describe("CLWRota sync — idempotent rerun", () => {
  const draft = (
    date: string,
    theatre: string,
    session: "am" | "pm",
    specialty: string | null,
    consultant: string | null,
  ): Draft => ({
    session_date: date,
    theatre_id: theatre,
    session,
    specialty_id: specialty,
    surgical_consultant: consultant,
  });

  const asg = (extId: string, date: string, session: "am" | "pm", staff: string): AsgDraft => ({
    staff_id: staff,
    session_date: date,
    session,
    duty_type: "theatre",
    role_on_list: "solo",
    theatre_session_id: null,
    clwrota_external_id: extId,
  });

  it("rerun over the same 12 months inserts ZERO new theatre_sessions", () => {
    const store = makeStore();
    // Seed a year of daily AM+PM lists across 6 theatres.
    const drafts: Draft[] = [];
    const start = new Date("2025-06-15").getTime();
    for (let d = 0; d < 365; d++) {
      const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
      for (const t of ["t1", "t2", "t3", "t4", "t5", "t6"]) {
        drafts.push(draft(day, t, "am", "spec-ent", "Dr Smith"));
        drafts.push(draft(day, t, "pm", "spec-uro", "Dr Jones"));
      }
    }

    store.runSync(drafts, []);
    const afterFirst = store.sessions.length;
    expect(afterFirst).toBe(365 * 6 * 2);

    store.runSync(drafts, []);
    expect(store.sessions.length).toBe(afterFirst); // no duplicates

    // And IDs are stable — same key resolves to the same row id.
    const idsByKey = new Map(store.sessions.map((s) => [`${s.session_date}|${s.theatre_id}|${s.session}`, s.id]));
    store.runSync(drafts, []);
    for (const s of store.sessions) {
      expect(idsByKey.get(`${s.session_date}|${s.theatre_id}|${s.session}`)).toBe(s.id);
    }
  });

  it("rerun with a NULL consultant does NOT blank a previously-stored consultant", () => {
    const store = makeStore();
    store.runSync([draft("2025-07-01", "t1", "am", "spec-ent", "Dr Smith")], []);
    expect(store.sessions[0].surgical_consultant).toBe("Dr Smith");

    // Second sync — feed temporarily lost the consultant name.
    store.runSync([draft("2025-07-01", "t1", "am", "spec-ent", null)], []);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].surgical_consultant).toBe("Dr Smith"); // preserved
    expect(store.sessions[0].specialty_id).toBe("spec-ent");
  });

  it("rerun with a NULL specialty does NOT blank a previously-stored specialty", () => {
    const store = makeStore();
    store.runSync([draft("2025-07-01", "t1", "am", "spec-uro", "Dr Jones")], []);
    expect(store.sessions[0].specialty_id).toBe("spec-uro");

    store.runSync([draft("2025-07-01", "t1", "am", null, "Dr Jones")], []);
    expect(store.sessions[0].specialty_id).toBe("spec-uro"); // preserved
    expect(store.sessions[0].surgical_consultant).toBe("Dr Jones");
  });

  it("rerun WITH a fresh consultant/specialty correctly overwrites null DB values", () => {
    const store = makeStore();
    store.runSync([draft("2025-07-01", "t1", "am", null, null)], []);
    expect(store.sessions[0].specialty_id).toBeNull();
    expect(store.sessions[0].surgical_consultant).toBeNull();

    store.runSync([draft("2025-07-01", "t1", "am", "spec-ent", "Dr Smith")], []);
    expect(store.sessions[0].specialty_id).toBe("spec-ent");
    expect(store.sessions[0].surgical_consultant).toBe("Dr Smith");
  });

  it("rerun does NOT duplicate rota_assignments keyed by clwrota_external_id", () => {
    const store = makeStore();
    const drafts: Draft[] = [draft("2025-07-01", "t1", "am", "spec-ent", "Dr Smith")];
    const asgs: AsgDraft[] = [
      asg("ext-1", "2025-07-01", "am", "staff-a"),
      asg("ext-2", "2025-07-01", "am", "staff-b"),
    ];
    store.runSync(drafts, asgs);
    store.runSync(drafts, asgs);
    store.runSync(drafts, asgs);
    expect(store.assignments).toHaveLength(2);
  });

  it("rerun preserves locally_modified rota_assignments untouched", () => {
    const store = makeStore();
    store.runSync(
      [draft("2025-07-01", "t1", "am", "spec-ent", "Dr Smith")],
      [asg("ext-1", "2025-07-01", "am", "staff-a")],
    );
    // Coordinator hand-edits the row.
    store.assignments[0].locally_modified = true;
    store.assignments[0].role_on_list = "supervised";
    store.assignments[0].staff_id = "staff-x";

    // Sync rerun would try to put it back to solo / staff-a.
    store.runSync(
      [draft("2025-07-01", "t1", "am", "spec-ent", "Dr Smith")],
      [asg("ext-1", "2025-07-01", "am", "staff-a")],
    );
    expect(store.assignments[0].role_on_list).toBe("supervised");
    expect(store.assignments[0].staff_id).toBe("staff-x");
  });

  it("mixed bucket batch (some with consultant, some without) preserves each row's prior value", () => {
    const store = makeStore();
    // Seed two sessions with consultants set.
    store.runSync(
      [
        draft("2025-07-01", "t1", "am", "spec-ent", "Dr Smith"),
        draft("2025-07-01", "t2", "am", "spec-uro", "Dr Jones"),
      ],
      [],
    );
    // Second run: one row keeps the consultant, the other arrives with null.
    store.runSync(
      [
        draft("2025-07-01", "t1", "am", "spec-ent", null), // null consultant
        draft("2025-07-01", "t2", "am", "spec-uro", "Dr Jones"),
      ],
      [],
    );
    const t1 = store.sessions.find((s) => s.theatre_id === "t1")!;
    const t2 = store.sessions.find((s) => s.theatre_id === "t2")!;
    expect(t1.surgical_consultant).toBe("Dr Smith"); // preserved across bucket split
    expect(t2.surgical_consultant).toBe("Dr Jones");
  });
});
