import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchReportRaw, parseRows, pick, normaliseDate, normaliseSession } from "./parsing";

/**
 * Integration test: mocks the CLWRota Central API and verifies the sync
 * pipeline correctly updates the global calendar (theatre_sessions +
 * rota_assignments) and the staff roster (profiles).
 *
 * Rather than invoking `performRotaSync` / `performStaffSync` — which are
 * ~1800 lines wired to `supabaseAdmin`'s chained builder and hundreds of
 * production lookups — we exercise the real network + parsing boundary
 * (`fetchReportRaw` + `parseRows`) against a stubbed `fetch`, then feed
 * the parsed rows through an in-memory store that models the same UNIQUE
 * constraints and merge semantics that the production sync relies on:
 *
 *   - profiles: matched by clwrota_external_id, falling back to email
 *   - theatre_sessions: UNIQUE (session_date, theatre_id, session)
 *   - rota_assignments: UNIQUE (clwrota_external_id)
 *
 * This mirrors the pattern in `clwrota-sync-idempotence.test.ts`.
 */

// ---- Mocked CLWRota Central API payloads ----------------------------------

const STAFF_URL = "https://central.example/api/staff.json?fields=all";
const ROTA_URL = "https://central.example/api/rota.json?start_date=2025-06-01&end_date=2025-06-30";
const API_KEY = "test-api-key-123";

/** Rotamap `central_api` shape: { columns, rows } with parallel arrays. */
const staffPayload = {
  columns: ["local_id", "first_name", "last_name", "email", "grade"],
  rows: [
    ["ext-consultant-1", "Alice", "Ng", "alice.ng@nhs.example", "consultant"],
    ["ext-consultant-2", "Bob", "Patel", "bob.patel@nhs.example", "consultant"],
    ["ext-sas-1", "Carla", "Ortiz", "carla.ortiz@nhs.example", "sas"],
  ],
};

/** Rota "generic array" shape: array of row objects (also supported by parseRows). */
const rotaPayload = [
  {
    external_id: "asg-1",
    date: "2025-06-07", // Saturday
    session: "AM",
    theatre: "Theatre 1",
    staff_local_id: "ext-consultant-1",
    role: "solo",
    duty_type: "theatre",
  },
  {
    external_id: "asg-2",
    date: "2025-06-07",
    session: "PM",
    theatre: "Theatre 1",
    staff_local_id: "ext-consultant-1",
    role: "solo",
    duty_type: "theatre",
  },
  {
    external_id: "asg-3",
    date: "2025-06-09", // Monday
    session: "AM",
    theatre: "Theatre 2",
    staff_local_id: "ext-consultant-2",
    role: "solo",
    duty_type: "theatre",
  },
  {
    external_id: "asg-4",
    date: "2025-06-09",
    session: "AM",
    theatre: "Theatre 2",
    staff_local_id: "ext-sas-1",
    role: "supervised",
    duty_type: "theatre",
  },
];

// ---- Fetch stub -----------------------------------------------------------

type FetchCall = { url: string; headers: Record<string, string> };
let fetchCalls: FetchCall[] = [];

function installFetchMock() {
  const impl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    }
    fetchCalls.push({ url, headers });

    // Match on URL prefix so the parsing layer's window-rewriter (which
    // may mutate `end_date=`) still routes to the right payload.
    if (url.startsWith("https://central.example/api/staff")) {
      return Promise.resolve(
        new Response(JSON.stringify(staffPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.startsWith("https://central.example/api/rota")) {
      return Promise.resolve(
        new Response(JSON.stringify(rotaPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

// ---- In-memory sync store -------------------------------------------------

type Profile = {
  id: string;
  clwrota_external_id: string | null;
  email: string | null;
  full_name: string;
  grade: string | null;
  active: boolean;
};

type TheatreSession = {
  id: string;
  session_date: string;
  theatre_id: string;
  session: "am" | "pm";
};

type Assignment = {
  id: string;
  clwrota_external_id: string;
  staff_id: string | null;
  session_date: string;
  session: "am" | "pm";
  theatre_session_id: string | null;
  role_on_list: string;
  duty_type: string;
};

function makeStore(seed?: { profiles?: Profile[]; theatres?: Array<{ id: string; name: string }> }) {
  let nextId = 1;
  const newId = (prefix: string) => `${prefix}-${nextId++}`;

  const profiles: Profile[] = [...(seed?.profiles ?? [])];
  const theatres = new Map<string, string>(
    (seed?.theatres ?? []).map((t) => [t.name.toLowerCase(), t.id]),
  );
  const sessions: TheatreSession[] = [];
  const assignments: Assignment[] = [];

  const sessionKey = (s: { session_date: string; theatre_id: string; session: string }) =>
    `${s.session_date}|${s.theatre_id}|${s.session}`;
  const sessionByKey = new Map<string, TheatreSession>();

  /** Roster upsert — matches CLWRota staff rows to profiles by external
   *  id first, then by email; unmatched rows are inserted as new active
   *  permanent staff. */
  const syncStaff = (rows: Record<string, unknown>[]) => {
    let matched = 0;
    let inserted = 0;
    for (const r of rows) {
      const extId = pick(r, ["local_id", "external_id", "person.local_id"]);
      const email = pick(r, ["email", "email_address"])?.toLowerCase() ?? null;
      const first = pick(r, ["first_name"]) ?? "";
      const last = pick(r, ["last_name"]) ?? "";
      const grade = pick(r, ["grade"]);
      const full_name = `${first} ${last}`.trim();

      let existing = extId
        ? profiles.find((p) => p.clwrota_external_id === extId)
        : undefined;
      if (!existing && email) existing = profiles.find((p) => p.email?.toLowerCase() === email);

      if (existing) {
        // Fill in any newly-known fields without blanking prior values.
        if (extId) existing.clwrota_external_id = extId;
        if (email && !existing.email) existing.email = email;
        if (full_name) existing.full_name = full_name;
        if (grade) existing.grade = grade;
        existing.active = true;
        matched++;
      } else {
        profiles.push({
          id: newId("profile"),
          clwrota_external_id: extId,
          email,
          full_name,
          grade,
          active: true,
        });
        inserted++;
      }
    }
    return { matched, inserted, total: rows.length };
  };

  /** Calendar upsert. Rejects rows we can't map to a known theatre/staff. */
  const syncRota = (rows: Record<string, unknown>[]) => {
    const skipped: Array<{ label: string; reason: string }> = [];
    let sessionsUpserted = 0;
    let assignmentsInserted = 0;
    let assignmentsUpdated = 0;

    for (const r of rows) {
      const extAsgId = pick(r, ["external_id", "id"]);
      const date = normaliseDate(pick(r, ["date", "session_date"]));
      const half = normaliseSession(pick(r, ["session", "am_pm"]));
      const theatreName = pick(r, ["theatre", "theatre_name"]);
      const staffExt = pick(r, ["staff_local_id", "person.local_id"]);
      const role = pick(r, ["role", "role_on_list"]) ?? "solo";
      const dutyType = pick(r, ["duty_type"]) ?? "theatre";

      if (!extAsgId || !date || !half || !theatreName || !staffExt) {
        skipped.push({ label: extAsgId ?? "(no id)", reason: "missing required field" });
        continue;
      }

      const theatreId = theatres.get(theatreName.toLowerCase());
      if (!theatreId) {
        skipped.push({ label: extAsgId, reason: `unknown theatre "${theatreName}"` });
        continue;
      }
      const staff = profiles.find((p) => p.clwrota_external_id === staffExt);
      if (!staff) {
        skipped.push({ label: extAsgId, reason: `unknown staff "${staffExt}"` });
        continue;
      }

      // theatre_sessions upsert (UNIQUE on date+theatre+session).
      const skey = sessionKey({ session_date: date, theatre_id: theatreId, session: half });
      let ts = sessionByKey.get(skey);
      if (!ts) {
        ts = { id: newId("ts"), session_date: date, theatre_id: theatreId, session: half };
        sessions.push(ts);
        sessionByKey.set(skey, ts);
        sessionsUpserted++;
      }

      // rota_assignments upsert (UNIQUE on clwrota_external_id).
      const prior = assignments.find((a) => a.clwrota_external_id === extAsgId);
      if (prior) {
        prior.staff_id = staff.id;
        prior.session_date = date;
        prior.session = half;
        prior.theatre_session_id = ts.id;
        prior.role_on_list = role;
        prior.duty_type = dutyType;
        assignmentsUpdated++;
      } else {
        assignments.push({
          id: newId("asg"),
          clwrota_external_id: extAsgId,
          staff_id: staff.id,
          session_date: date,
          session: half,
          theatre_session_id: ts.id,
          role_on_list: role,
          duty_type: dutyType,
        });
        assignmentsInserted++;
      }
    }

    return { sessionsUpserted, assignmentsInserted, assignmentsUpdated, skipped };
  };

  return { profiles, sessions, assignments, syncStaff, syncRota };
}

// ---- Tests ---------------------------------------------------------------

beforeEach(() => {
  fetchCalls = [];
  installFetchMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CLWRota Central API sync — integration", () => {
  it("fetches with the configured API key and reports the correct row counts", async () => {
    const staffText = await fetchReportRaw(STAFF_URL, API_KEY, {
      maxAttempts: 1,
      baseDelayMs: 0,
    });
    const rotaText = await fetchReportRaw(ROTA_URL, API_KEY, {
      maxAttempts: 1,
      baseDelayMs: 0,
    });

    // Real fetch mock was hit, with the CLWRota-required X-Auth header.
    expect(fetchCalls).toHaveLength(2);
    for (const c of fetchCalls) {
      expect(c.headers["x-auth"]).toBe(API_KEY);
    }

    expect(parseRows(staffText).rows).toHaveLength(3);
    expect(parseRows(rotaText).rows).toHaveLength(4);
  });

  it("updates the staff roster: matches existing profiles and inserts new ones", async () => {
    const store = makeStore({
      profiles: [
        // Existing consultant already linked by external id — should match, not duplicate.
        {
          id: "profile-existing-1",
          clwrota_external_id: "ext-consultant-1",
          email: "alice.ng@nhs.example",
          full_name: "Alice Ng",
          grade: "consultant",
          active: true,
        },
        // Existing SAS with only an email — should match via email fallback and
        // gain its external id.
        {
          id: "profile-existing-2",
          clwrota_external_id: null,
          email: "carla.ortiz@nhs.example",
          full_name: "Carla O",
          grade: "sas",
          active: true,
        },
      ],
      theatres: [
        { id: "theatre-1", name: "Theatre 1" },
        { id: "theatre-2", name: "Theatre 2" },
      ],
    });

    const staffText = await fetchReportRaw(STAFF_URL, API_KEY, { maxAttempts: 1, baseDelayMs: 0 });
    const result = store.syncStaff(parseRows(staffText).rows);

    expect(result).toEqual({ total: 3, matched: 2, inserted: 1 });
    expect(store.profiles).toHaveLength(3);

    const carla = store.profiles.find((p) => p.email === "carla.ortiz@nhs.example")!;
    expect(carla.id).toBe("profile-existing-2"); // matched, not re-inserted
    expect(carla.clwrota_external_id).toBe("ext-sas-1"); // backfilled from Central

    const bob = store.profiles.find((p) => p.clwrota_external_id === "ext-consultant-2")!;
    expect(bob.full_name).toBe("Bob Patel");
    expect(bob.active).toBe(true);
  });

  it("updates the global calendar: creates theatre_sessions and rota_assignments", async () => {
    const store = makeStore({
      theatres: [
        { id: "theatre-1", name: "Theatre 1" },
        { id: "theatre-2", name: "Theatre 2" },
      ],
    });
    // Roster first — the calendar sync needs profiles to resolve staff.
    store.syncStaff(parseRows(await fetchReportRaw(STAFF_URL, API_KEY, { maxAttempts: 1, baseDelayMs: 0 })).rows);

    const rotaText = await fetchReportRaw(ROTA_URL, API_KEY, { maxAttempts: 1, baseDelayMs: 0 });
    const result = store.syncRota(parseRows(rotaText).rows);

    expect(result.skipped).toEqual([]);
    // 3 distinct (date, theatre, session) triples: Sat AM T1, Sat PM T1, Mon AM T2.
    expect(result.sessionsUpserted).toBe(3);
    expect(store.sessions).toHaveLength(3);
    // 4 assignments (Mon AM T2 has two staff on the same session).
    expect(result.assignmentsInserted).toBe(4);
    expect(store.assignments).toHaveLength(4);

    // Both Mon-AM-T2 assignments share the same theatre_session_id.
    const monAm = store.assignments.filter(
      (a) => a.session_date === "2025-06-09" && a.session === "am",
    );
    expect(monAm).toHaveLength(2);
    expect(new Set(monAm.map((a) => a.theatre_session_id)).size).toBe(1);

    // Roles are captured on the assignment row.
    expect(monAm.map((a) => a.role_on_list).sort()).toEqual(["solo", "supervised"]);
  });

  it("skips rota rows that reference unknown theatres or staff without duplicating them on rerun", async () => {
    const store = makeStore({
      // Deliberately omit "Theatre 2" and Bob so those rows can't be matched.
      profiles: [
        {
          id: "p-1",
          clwrota_external_id: "ext-consultant-1",
          email: "alice.ng@nhs.example",
          full_name: "Alice Ng",
          grade: "consultant",
          active: true,
        },
      ],
      theatres: [{ id: "theatre-1", name: "Theatre 1" }],
    });

    const rows = parseRows(
      await fetchReportRaw(ROTA_URL, API_KEY, { maxAttempts: 1, baseDelayMs: 0 }),
    ).rows;

    const first = store.syncRota(rows);
    expect(first.assignmentsInserted).toBe(2); // only the two Theatre 1 rows
    expect(first.skipped.map((s) => s.reason).sort()).toEqual([
      `unknown theatre "Theatre 2"`,
      `unknown theatre "Theatre 2"`,
    ]);

    // Rerun — same feed. UNIQUE(clwrota_external_id) means the two matched
    // rows are updated in place; nothing new is inserted.
    const second = store.syncRota(rows);
    expect(second.assignmentsInserted).toBe(0);
    expect(second.assignmentsUpdated).toBe(2);
    expect(second.sessionsUpserted).toBe(0);
    expect(store.sessions).toHaveLength(1);
    expect(store.assignments).toHaveLength(2);
  });

  it("is idempotent across repeat sync runs (roster + calendar)", async () => {
    const store = makeStore({
      theatres: [
        { id: "theatre-1", name: "Theatre 1" },
        { id: "theatre-2", name: "Theatre 2" },
      ],
    });

    const runOnce = async () => {
      const staff = parseRows(
        await fetchReportRaw(STAFF_URL, API_KEY, { maxAttempts: 1, baseDelayMs: 0 }),
      ).rows;
      const rota = parseRows(
        await fetchReportRaw(ROTA_URL, API_KEY, { maxAttempts: 1, baseDelayMs: 0 }),
      ).rows;
      store.syncStaff(staff);
      return store.syncRota(rota);
    };

    await runOnce();
    const profilesAfter1 = store.profiles.length;
    const sessionsAfter1 = store.sessions.map((s) => s.id).sort();
    const assignmentsAfter1 = store.assignments.map((a) => a.id).sort();

    const second = await runOnce();
    const third = await runOnce();

    // Roster is stable — three staff rows total across every rerun.
    expect(store.profiles).toHaveLength(profilesAfter1);
    // Calendar sessions keep the same ids (no duplicates from UNIQUE constraint).
    expect(store.sessions.map((s) => s.id).sort()).toEqual(sessionsAfter1);
    expect(store.assignments.map((a) => a.id).sort()).toEqual(assignmentsAfter1);
    expect(second.assignmentsInserted).toBe(0);
    expect(second.sessionsUpserted).toBe(0);
    expect(third.assignmentsInserted).toBe(0);
    expect(third.sessionsUpserted).toBe(0);
  });
});
