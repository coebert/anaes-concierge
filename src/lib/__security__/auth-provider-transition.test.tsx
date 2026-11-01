// @vitest-environment jsdom
/**
 * Exercises the REAL AuthProvider (not just the guard) through account
 * switches with deliberately delayed profile loads, a hanging
 * cancelQueries(), sign-out and the initial getSession race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const h = vi.hoisted(() => ({
  authCb: null as null | ((event: string, s: unknown) => void),
  getSession: null as null | (() => Promise<unknown>),
  rolesLoads: new Map<string, Deferred<{ data: unknown; error: null }>[]>(),
  profileLoads: new Map<string, Deferred<{ data: unknown; error: null }>[]>(),
  signOut: vi.fn(async () => ({ error: null })),
}));

function pending(map: Map<string, Deferred<{ data: unknown; error: null }>[]>, uid: string) {
  const d = deferred<{ data: unknown; error: null }>();
  (map.get(uid) ?? map.set(uid, []).get(uid)!).push(d);
  return d.promise;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        h.authCb = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      getSession: () => h.getSession!(),
      signOut: () => h.signOut(),
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, uid: string) =>
          table === "user_roles"
            ? pending(h.rolesLoads, uid)
            : { maybeSingle: () => pending(h.profileLoads, uid) },
      }),
    }),
  },
}));
vi.mock("@/lib/remember-me", () => ({ shouldDropSessionOnLoad: () => false }));

import { AuthProvider, useAuth, type AuthState } from "@/lib/auth-context";

const sess = (id: string, token = "t1") => ({ access_token: token, user: { id } });
const snapshots: Array<Pick<AuthState, "loading" | "roles" | "fullName"> & { uid: string | null }> = [];
let latest: AuthState | null = null;
function Probe() {
  const a = useAuth();
  latest = a;
  snapshots.push({ uid: a.user?.id ?? null, loading: a.loading, roles: a.roles, fullName: a.fullName });
  return null;
}

async function settleLoad(uid: string, roles: string[], name: string, idx = -1) {
  const r = h.rolesLoads.get(uid)!.at(idx)!;
  const p = h.profileLoads.get(uid)!.at(idx)!;
  await act(async () => {
    r.resolve({ data: roles.map((role) => ({ role })), error: null });
    p.resolve({ data: { grade: "consultant", full_name: name }, error: null });
  });
}
const flushTimers = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

let qc: QueryClient;
function mount() {
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Every render that shows user X must never carry another account's data. */
function assertNoCrossIdentityRender(adminUid: string) {
  for (const s of snapshots) {
    if (s.uid !== adminUid) expect(s.roles).not.toContain("admin");
    if (s.uid !== adminUid) expect(s.fullName).not.toBe("Admin A");
  }
}

beforeEach(() => {
  snapshots.length = 0;
  latest = null;
  h.rolesLoads.clear();
  h.profileLoads.clear();
  h.signOut.mockClear();
  qc = new QueryClient();
});
afterEach(() => cleanup());

async function signInAsAdminA() {
  h.getSession = async () => ({ data: { session: sess("A") }, error: null });
  mount();
  await flushTimers();
  await settleLoad("A", ["admin"], "Admin A");
  expect(latest!.roles).toEqual(["admin"]);
  expect(latest!.loading).toBe(false);
}

describe("AuthProvider identity transitions", () => {
  it("A→B: B is never rendered with A's roles, name or cache — even before the timer fires", async () => {
    await signInAsAdminA();
    qc.setQueryData(["private"], "A-secret");
    // cancelQueries never resolves: the purge must not wait on it.
    vi.spyOn(qc, "cancelQueries").mockImplementation(() => new Promise(() => {}));

    act(() => h.authCb!("SIGNED_IN", sess("B")));
    // Synchronously after the event, before any setTimeout/await:
    expect(latest!.user?.id).toBe("B");
    expect(latest!.roles).toEqual([]);
    expect(latest!.fullName).toBeNull();
    expect(latest!.loading).toBe(true); // gate closed while B loads
    expect(qc.getQueryData(["private"])).toBeUndefined();

    await flushTimers();
    await settleLoad("B", ["staff"], "Staff B");
    expect(latest!.roles).toEqual(["staff"]);
    expect(latest!.loading).toBe(false);
    assertNoCrossIdentityRender("A");
  });

  it("a delayed A load settling after the switch to B is discarded (before and after B's timer)", async () => {
    h.getSession = async () => ({ data: { session: sess("A") }, error: null });
    mount();
    await flushTimers(); // A load started, still pending
    act(() => h.authCb!("SIGNED_IN", sess("B")));
    // A settles BEFORE B's deferred load has even started.
    await settleLoad("A", ["admin"], "Admin A");
    expect(latest!.user?.id).toBe("B");
    expect(latest!.roles).toEqual([]);
    expect(latest!.loading).toBe(true);
    await flushTimers();
    await settleLoad("B", ["staff"], "Staff B");
    expect(latest!.roles).toEqual(["staff"]);
    assertNoCrossIdentityRender("A");
  });

  it("A→B→A: the first A load cannot settle into the second A identity", async () => {
    h.getSession = async () => ({ data: { session: sess("A") }, error: null });
    mount();
    await flushTimers();
    act(() => h.authCb!("SIGNED_IN", sess("B")));
    act(() => h.authCb!("SIGNED_IN", sess("A", "t2")));
    await settleLoad("A", ["admin"], "STALE A", 0);
    expect(latest!.fullName).toBeNull();
    await flushTimers();
    await settleLoad("A", ["admin"], "Admin A");
    expect(latest!.fullName).toBe("Admin A");
  });

  it("sign-out clears roles and cache synchronously, before the network sign-out resolves", async () => {
    await signInAsAdminA();
    qc.setQueryData(["private"], "A-secret");
    let release!: () => void;
    h.signOut.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ error: null }))),
    );
    let done!: Promise<void>;
    act(() => {
      done = latest!.signOut();
    });
    expect(latest!.user).toBeNull();
    expect(latest!.roles).toEqual([]);
    expect(latest!.isCoordinatorOrAdmin()).toBe(false);
    expect(qc.getQueryData(["private"])).toBeUndefined();
    await act(async () => {
      release();
      await done;
    });
    expect(latest!.loading).toBe(false);
  });

  it("same-user TOKEN_REFRESHED keeps roles, cache and the open gate", async () => {
    await signInAsAdminA();
    qc.setQueryData(["private"], "A-data");
    const loadsBefore = h.rolesLoads.get("A")!.length;
    act(() => h.authCb!("TOKEN_REFRESHED", sess("A", "t2")));
    await flushTimers();
    expect(latest!.session?.access_token).toBe("t2");
    expect(latest!.roles).toEqual(["admin"]);
    expect(latest!.loading).toBe(false);
    expect(qc.getQueryData(["private"])).toBe("A-data");
    expect(h.rolesLoads.get("A")!.length).toBe(loadsBefore);
  });

  it("initial getSession race: a newer auth event wins over a stale getSession snapshot", async () => {
    const gs = deferred<unknown>();
    h.getSession = () => gs.promise;
    mount();
    expect(latest!.loading).toBe(true);
    act(() => h.authCb!("SIGNED_OUT", null));
    expect(latest!.loading).toBe(false);
    await act(async () => gs.resolve({ data: { session: sess("A") }, error: null }));
    await flushTimers();
    expect(latest!.user).toBeNull();
    expect(h.rolesLoads.get("A")).toBeUndefined();
  });

  it("initial getSession for B with a still-loading gate never exposes stale data", async () => {
    h.getSession = async () => ({ data: { session: sess("B") }, error: null });
    mount();
    await flushTimers();
    expect(latest!.user?.id).toBe("B");
    expect(latest!.loading).toBe(true);
    expect(latest!.roles).toEqual([]);
    await settleLoad("B", ["staff"], "Staff B");
    expect(latest!.loading).toBe(false);
  });
});
