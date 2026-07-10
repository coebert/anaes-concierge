// @vitest-environment jsdom
/**
 * UI-state regression for the wellbeing pages.
 *
 * The wellbeing dashboards refresh whenever a cancel-leave or exception
 * update mutation calls `invalidateWellbeing(qc)`. This test pins down
 * how the pages VISIBLY communicate that refresh cycle to the user:
 *
 *   1. During the refetch triggered by the mutation, each page shows a
 *      "refreshing" banner (data-testid `wellbeing-refetching` /
 *      `admin-wellbeing-refetching`) — otherwise a slow network round-trip
 *      looks like nothing happened.
 *
 *   2. If the refetch fails (Supabase 5xx, RLS regression, network drop),
 *      each page shows a destructive error banner (`wellbeing-error` /
 *      `admin-wellbeing-error`) carrying the underlying error message —
 *      otherwise the user sees a stale score with no cue that it's
 *      stale.
 *
 *   3. The banners disappear once a subsequent refetch succeeds, so a
 *      transient failure doesn't stick around after recovery.
 *
 * The Supabase client and the auth context are mocked minimally so the
 * pages render end-to-end against a shared, in-test controllable data
 * source. `mode` flips per-test between "success", "hang" (never
 * resolves, to observe the refetch banner), and "reject" (fails to
 * observe the error banner).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

// --------------------- shared mock state ---------------------

type Mode = "success" | "hang" | "reject";
const { control } = vi.hoisted(() => ({
  control: { mode: "success" as Mode, rejectMessage: "supabase read failed" },
}));

function currentPromise<T>(successValue: T): Promise<T> {
  if (control.mode === "reject") {
    return Promise.reject(new Error(control.rejectMessage));
  }
  if (control.mode === "hang") {
    // Deliberately never resolves — the query stays in "fetching" so the
    // refetching banner remains visible for the assertion.
    return new Promise<T>(() => {});
  }
  return Promise.resolve(successValue);
}

vi.mock("@/integrations/supabase/client", () => {
  function makeBuilder() {
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = () => api;
    api.gte = () => api;
    api.lte = () => api;
    api.neq = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.or = () => api;
    api.in = () => api;
    api.maybeSingle = () => currentPromise({ data: null, error: null });
    api.single = api.maybeSingle;
    // fetchAllPaged calls builder().range(from, to); returning an empty page
    // ends pagination immediately.
    api.range = () => currentPromise({ data: [] as unknown[], error: null });
    // Some callers await the builder chain directly.
    (api as Record<string, unknown>).then = (
      ok: (v: { data: unknown[]; error: null }) => unknown,
      err: (e: unknown) => unknown,
    ) => currentPromise({ data: [] as unknown[], error: null }).then(ok, err);
    return api;
  }
  return {
    supabase: {
      from: () => makeBuilder(),
      rpc: () => currentPromise({ data: [] as unknown[], error: null }),
    },
  };
});

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    loading: false,
    hasRole: () => true,
    isCoordinatorOrAdmin: () => true,
    user: { id: "user-1" },
    session: {},
    roles: ["admin"],
    grade: null,
    fullName: "Test User",
    isAuthenticated: true,
    isTrainee: () => false,
    signOut: async () => {},
    refreshRoles: async () => {},
  }),
}));

// Router primitives aren't needed for component-render assertions.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (_config: unknown) => ({ options: _config }),
    Navigate: ({ to }: { to: string }) => <span data-testid="navigate" data-to={to} />,
    Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// The pulse-survey / recognition dialogs are irrelevant to the banner
// contract — replace with stubs so we don't have to mock their internals.
vi.mock("@/components/wellbeing/PulseSurveyDialog", () => ({
  PulseSurveyDialog: () => null,
}));
vi.mock("@/components/wellbeing/RecognitionDialog", () => ({
  RecognitionDialog: () => null,
}));

// Import the pages AFTER all mocks are in place so their module graph binds
// to the mocked supabase client / auth context.
const { WellbeingPage } = await import("@/routes/_authenticated/wellbeing");
const { AdminWellbeingPage } = await import("@/routes/_authenticated/admin.wellbeing");

// --------------------- harness ---------------------

function renderWith(component: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>{component}</QueryClientProvider>,
  );
  return { qc, ...utils };
}

async function waitForInitialLoad(qc: QueryClient) {
  // The initial fetch resolves against the "success" mock. Wait for the
  // QueryClient to report no in-flight fetches so subsequent assertions
  // start from a stable data-loaded baseline.
  await waitFor(
    () => {
      expect(qc.isFetching()).toBe(0);
    },
    { timeout: 3000 },
  );
}

beforeEach(() => {
  control.mode = "success";
  control.rejectMessage = "supabase read failed";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// --------------------- tests ---------------------

describe("wellbeing pages — refetch loading state + mutation error banner", () => {
  it(
    "my-wellbeing shows the refetching banner while an invalidation-triggered " +
      "refetch is in flight, then clears it once the refetch succeeds",
    async () => {
      const { qc } = renderWith(<WellbeingPage />);
      await waitForInitialLoad(qc);

      // Sanity — no banners are visible in the resting state.
      expect(screen.queryByTestId("wellbeing-refetching")).toBeNull();
      expect(screen.queryByTestId("wellbeing-error")).toBeNull();

      // Simulate the cancel-leave / exception-withdraw mutation kicking off
      // a background refetch that hasn't finished yet.
      control.mode = "hang";
      await act(async () => {
        void qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
      });

      await waitFor(() => {
        expect(screen.getByTestId("wellbeing-refetching")).toBeTruthy();
      });
      expect(screen.getByTestId("wellbeing-refetching").textContent).toMatch(
        /Refreshing/i,
      );

      // Recovery: the mutation's refetch eventually completes → banner clears.
      control.mode = "success";
      await act(async () => {
        await qc.refetchQueries({ queryKey: ["my-wellbeing"] });
      });
      await waitFor(() => {
        expect(screen.queryByTestId("wellbeing-refetching")).toBeNull();
      });
    },
  );

  it(
    "my-wellbeing shows the error banner with the underlying message when the " +
      "post-mutation refetch fails, and clears it on the next successful refetch",
    async () => {
      const { qc } = renderWith(<WellbeingPage />);
      await waitForInitialLoad(qc);

      // Simulate a mutation-triggered refetch that hits a Supabase error.
      control.mode = "reject";
      control.rejectMessage = "leave_requests read denied by RLS";
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
      });

      const banner = await screen.findByTestId("wellbeing-error");
      expect(banner.textContent).toMatch(/Wellbeing update failed/i);
      expect(banner.textContent).toMatch(/leave_requests read denied by RLS/);
      // The banner is a live region for screen readers.
      expect(banner.getAttribute("role")).toBe("alert");

      // Recovery: a successful retry clears the banner (no sticky error).
      control.mode = "success";
      await act(async () => {
        await qc.refetchQueries({ queryKey: ["my-wellbeing"] });
      });
      await waitFor(() => {
        expect(screen.queryByTestId("wellbeing-error")).toBeNull();
      });
    },
  );

  it(
    "admin-wellbeing shows the refetching banner while an invalidation-triggered " +
      "refetch is in flight, then clears it once the refetch succeeds",
    async () => {
      const { qc } = renderWith(<AdminWellbeingPage />);
      await waitForInitialLoad(qc);

      expect(screen.queryByTestId("admin-wellbeing-refetching")).toBeNull();
      expect(screen.queryByTestId("admin-wellbeing-error")).toBeNull();

      control.mode = "hang";
      await act(async () => {
        void qc.invalidateQueries({ queryKey: ["admin-wellbeing"] });
      });

      await waitFor(() => {
        expect(screen.getByTestId("admin-wellbeing-refetching")).toBeTruthy();
      });

      control.mode = "success";
      await act(async () => {
        await qc.refetchQueries({ queryKey: ["admin-wellbeing"] });
      });
      await waitFor(() => {
        expect(screen.queryByTestId("admin-wellbeing-refetching")).toBeNull();
      });
    },
  );

  it(
    "admin-wellbeing shows the error banner with the underlying message when the " +
      "post-mutation refetch fails, and clears it on the next successful refetch",
    async () => {
      const { qc } = renderWith(<AdminWellbeingPage />);
      await waitForInitialLoad(qc);

      control.mode = "reject";
      control.rejectMessage = "exception_reports update failed";
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["admin-wellbeing"] });
      });

      const banner = await screen.findByTestId("admin-wellbeing-error");
      expect(banner.textContent).toMatch(/Wellbeing update failed/i);
      expect(banner.textContent).toMatch(/exception_reports update failed/);
      expect(banner.getAttribute("role")).toBe("alert");

      control.mode = "success";
      await act(async () => {
        await qc.refetchQueries({ queryKey: ["admin-wellbeing"] });
      });
      await waitFor(() => {
        expect(screen.queryByTestId("admin-wellbeing-error")).toBeNull();
      });
    },
  );

  it(
    "error banner and refetching banner do not appear simultaneously — an in-flight " +
      "refetch replaces the previous error state until it resolves",
    async () => {
      const { qc } = renderWith(<WellbeingPage />);
      await waitForInitialLoad(qc);

      control.mode = "reject";
      control.rejectMessage = "transient failure";
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
      });
      await screen.findByTestId("wellbeing-error");

      // A retry begins (hang) — the refetching banner must appear and the
      // stale error banner clears while the retry is pending.
      control.mode = "hang";
      await act(async () => {
        void qc.refetchQueries({ queryKey: ["my-wellbeing"] });
      });
      await waitFor(() => {
        expect(screen.getByTestId("wellbeing-refetching")).toBeTruthy();
        expect(screen.queryByTestId("wellbeing-error")).toBeNull();
      });
    },
  );
});
