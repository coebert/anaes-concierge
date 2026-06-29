// @vitest-environment jsdom
/**
 * UI test: the "My leave" tab tells the user when its scope is intentionally
 * personal even though they have org-wide visibility.
 *
 * - Regular staff: tab trigger label has NO "Personal view" badge; tab
 *   description reads "All your leave requests and their current status."
 * - Coordinator / admin: tab trigger label shows a "Personal view" badge;
 *   tab description explains the tab is scoped to their own requests and
 *   points them at the org-wide tabs.
 *
 * Renders the two exported tab pieces from leave.tsx directly so the test
 * exercises the exact JSX shipped on the route, without needing to mount
 * the full LeavePage data-loading tree.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";

import { MyLeaveTabLabel, MyLeaveDescription } from "./leave";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

afterEach(() => cleanup());

function renderMyLeaveTab(isCoordinatorOrAdmin: boolean) {
  return render(
    <Tabs defaultValue="mine">
      <TabsList>
        <TabsTrigger value="mine" className="gap-2">
          <MyLeaveTabLabel isCoordinatorOrAdmin={isCoordinatorOrAdmin} />
        </TabsTrigger>
      </TabsList>
      <TabsContent value="mine">
        <MyLeaveDescription isCoordinatorOrAdmin={isCoordinatorOrAdmin} />
      </TabsContent>
    </Tabs>,
  );
}

describe("My leave tab — coordinator/admin scope indicator", () => {
  it("regular staff: no 'Personal view' badge, neutral description copy", () => {
    renderMyLeaveTab(false);

    const trigger = screen.getByRole("tab", { name: /my leave/i });
    expect(within(trigger).queryByText(/personal view/i)).toBeNull();

    expect(
      screen.getByText("All your leave requests and their current status."),
    ).toBeTruthy();
    expect(screen.queryByText(/as a coordinator\/admin/i)).toBeNull();
  });

  it("coordinator/admin: 'Personal view' badge on the trigger, scope-explainer copy", () => {
    renderMyLeaveTab(true);

    const trigger = screen.getByRole("tab", { name: /my leave/i });
    // Badge is rendered inside the tab trigger.
    expect(within(trigger).getByText(/personal view/i)).toBeTruthy();

    // Coordinator-aware description copy appears in the panel.
    expect(
      screen.getByText(
        /this tab shows only your own requests\. as a coordinator\/admin, you can also view other staff leave records in the department calendar and all upcoming tabs\./i,
      ),
    ).toBeTruthy();

    // The neutral copy MUST NOT also appear.
    expect(
      screen.queryByText("All your leave requests and their current status."),
    ).toBeNull();
  });
});
