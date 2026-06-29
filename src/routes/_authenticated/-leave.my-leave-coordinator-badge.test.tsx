// @vitest-environment jsdom
/**
 * UI test: the "My leave" tab on /leave must communicate scope based on the
 * signed-in user's role.
 *
 * - Regular staff: tab trigger has NO "Personal view" badge; description
 *   reads "All your leave requests and their current status."
 * - Coordinator / admin: tab trigger shows a "Personal view" badge; the
 *   description explains the tab is scoped to their own requests and that
 *   they can see other staff leave in the Department calendar / All
 *   upcoming tabs.
 *
 * Mocks supabase (empty result set), the auth context, and the file-route
 * factory so the page can render outside the router. Also mocks the leave
 * request dialog (it pulls in a much wider dependency surface).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

// jsdom polyfills for Radix
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;
// Radix Select / Popover use hasPointerCapture / scrollIntoView
if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
    () => false;
}
if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
}

// --- Mocks ---------------------------------------------------------------

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (opts: Record<string, unknown>) => ({ options: opts }),
}));

// Chainable supabase mock: any builder method returns the same proxy and
// awaiting it resolves to { data: [], error: null }.
vi.mock("@/integrations/supabase/client", () => {
  const makeBuilder = () => {
    const result = { data: [], error: null };
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: typeof result) => unknown) => Promise.resolve(resolve(result));
        }
        return () => proxy;
      },
    };
    const proxy: object = new Proxy({}, handler);
    return proxy;
  };
  return {
    supabase: {
      from: () => makeBuilder(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/leave-request-dialog", () => ({
  LeaveRequestDialog: () => null,
}));

// useAuth — swapped per test via the `currentAuth` variable.
type AuthShape = {
  user: { id: string } | null;
  isCoordinatorOrAdmin: () => boolean;
  isTrainee: () => boolean;
  hasRole: () => boolean;
  fullName: string | null;
  grade: string | null;
};
let currentAuth: AuthShape;
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => currentAuth,
}));

// --- Test target ---------------------------------------------------------

import * as LeaveRoute from "./leave";

function LeavePageHarness() {
  // Route export shape from createFileRoute mock: { options: { component } }
  const route = (LeaveRoute as unknown as { Route: { options: { component: React.FC } } }).Route;
  const Page = route.options.component;
  return <Page />;
}

beforeEach(() => {
  currentAuth = {
    user: { id: "user-1" },
    isCoordinatorOrAdmin: () => false,
    isTrainee: () => false,
    hasRole: () => false,
    fullName: "Dr Robert Coe",
    grade: "consultant",
  };
});
afterEach(() => cleanup());

async function openMyLeaveTab() {
  const trigger = await screen.findByRole("tab", { name: /my leave/i });
  fireEvent.click(trigger);
  return trigger;
}

describe("My leave tab — coordinator/admin scope indicator", () => {
  it("regular staff: no 'Personal view' badge and shows neutral description", async () => {
    render(<LeavePageHarness />);
    const trigger = await openMyLeaveTab();

    // Badge is NOT inside the tab trigger.
    expect(within(trigger).queryByText(/personal view/i)).toBeNull();

    // Neutral description copy appears in the panel.
    await waitFor(() => {
      expect(
        screen.getByText("All your leave requests and their current status."),
      ).toBeTruthy();
    });
    expect(
      screen.queryByText(/as a coordinator\/admin/i),
    ).toBeNull();
  });

  it("coordinator/admin: 'Personal view' badge on tab + scope-explainer description", async () => {
    currentAuth = {
      ...currentAuth,
      isCoordinatorOrAdmin: () => true,
      hasRole: () => true,
    };
    render(<LeavePageHarness />);
    const trigger = await openMyLeaveTab();

    // Badge IS inside the tab trigger.
    expect(within(trigger).getByText(/personal view/i)).toBeTruthy();

    // Coordinator-aware description copy appears in the panel.
    await waitFor(() => {
      expect(
        screen.getByText(/as a coordinator\/admin, you can also view other staff leave records/i),
      ).toBeTruthy();
    });
    expect(
      screen.queryByText("All your leave requests and their current status."),
    ).toBeNull();
  });
});
