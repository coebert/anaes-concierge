// @vitest-environment jsdom
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

afterEach(() => cleanup());

const { calls, state } = vi.hoisted(() => ({
  calls: [] as { table: string; order: readonly string[] }[],
  state: { failDismissals: false },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ options: opts }),
  Navigate: () => null,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ hasRole: () => true, loading: false, user: { id: "u-synthetic" } }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/paged-select", () => ({
  pagedRows: vi.fn(async (table: string, _cols: string, opts: { order: readonly string[] }) => {
    calls.push({ table, order: opts.order });
    if (table === "inbox_dismissals" && state.failDismissals)
      throw new Error("inbox_dismissals page failed");
    return { data: [], error: null };
  }),
}));

import { Route } from "./admin.inbox";

const Page = (Route as unknown as { options: { component: () => React.ReactElement } }).options
  .component;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  state.failDismissals = false;
});

describe("coordinator inbox dismissals", () => {
  it("orders dismissals by the real key item_id (there is no id column)", async () => {
    renderPage();
    await screen.findByText(/inbox zero/i);
    expect(calls.find((c) => c.table === "inbox_dismissals")?.order).toEqual(["item_id"]);
  });

  it("a failed dismissal read shows Retry instead of an inbox; Retry recovers", async () => {
    state.failDismissals = true;
    renderPage();
    await screen.findByText(/inbox_dismissals page failed/);
    expect(screen.queryByText(/inbox zero/i)).toBeNull();
    state.failDismissals = false;
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/inbox zero/i)).toBeTruthy());
  });
});
