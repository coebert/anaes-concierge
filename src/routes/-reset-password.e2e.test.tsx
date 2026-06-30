// @vitest-environment jsdom
/**
 * End-to-end UI test for the reset-password journey.
 *
 * Stage 1 — Request a link:
 *   - User lands on /reset-password with no params.
 *   - The "Send reset link" form is shown.
 *   - Submitting calls supabase.auth.resetPasswordForEmail with the redirect
 *     pointing back at /reset-password on the current origin.
 *
 * Stage 2 — PKCE callback (?code=...):
 *   - User clicks the email link and lands at /reset-password?code=abc.
 *   - The page exchanges the code for a session via exchangeCodeForSession.
 *   - The ?code= param is stripped from the URL (so refresh can't re-exchange).
 *   - The view switches to "Set a new password".
 *   - Submitting calls supabase.auth.updateUser with the new password.
 *
 * Supabase is fully mocked; TanStack Router primitives are stubbed so the
 * route can render outside a real router context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

const { resetPasswordForEmail, exchangeCodeForSession, updateUser, onAuthStateChange } =
  vi.hoisted(() => ({
    resetPasswordForEmail: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    updateUser: vi.fn(),
    onAuthStateChange: vi.fn(),
  }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: (_path: string) => (opts: Record<string, unknown>) => ({
      options: opts,
    }),
    Link: ({
      children,
      to,
      ...rest
    }: React.PropsWithChildren<{ to?: string } & Record<string, unknown>>) =>
      React.createElement("a", { href: to, ...rest }, children),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: (...args: unknown[]) => resetPasswordForEmail(...args),
      exchangeCodeForSession: (...args: unknown[]) => exchangeCodeForSession(...args),
      updateUser: (...args: unknown[]) => updateUser(...args),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChange(...args),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { Route } from "./reset-password";

const ResetPasswordPage = (
  Route as unknown as { options: { component: React.ComponentType } }
).options.component;

function setLocation(href: string): void {
  window.history.replaceState({}, "", href);
}

beforeEach(() => {
  resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  updateUser.mockReset().mockResolvedValue({ error: null });
  onAuthStateChange.mockReset().mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  setLocation("/reset-password");
});

afterEach(() => {
  cleanup();
});

describe("reset password journey", () => {
  it("stage 1: requests a reset link with the /reset-password redirect", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await waitFor(() =>
      expect(screen.getByText(/^reset password$/i)).toBeDefined(),
    );
    expect(screen.getByLabelText(/email/i)).toBeDefined();

    await user.type(screen.getByLabelText(/email/i), "robert.coe1@nhs.net");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalledTimes(1));
    const [email, opts] = resetPasswordForEmail.mock.calls[0] as [
      string,
      { redirectTo: string },
    ];
    expect(email).toBe("robert.coe1@nhs.net");
    expect(opts.redirectTo).toMatch(/\/reset-password$/);
    expect(opts.redirectTo.startsWith(window.location.origin)).toBe(true);
  });

  it("stage 2: PKCE ?code= callback exchanges, cleans the URL, and updates password", async () => {
    const user = userEvent.setup();
    setLocation("/reset-password?code=pkce-abc-123");

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    // Code is exchanged for a session.
    await waitFor(() =>
      expect(exchangeCodeForSession).toHaveBeenCalledWith("pkce-abc-123"),
    );

    // ?code= is stripped so a refresh can't re-use the one-time code.
    await waitFor(() =>
      expect(window.location.search).not.toContain("code="),
    );

    // View switches to the new-password form.
    await waitFor(() =>
      expect(
        screen.getByText(/set a new password/i),
      ).toBeDefined(),
    );

    await user.type(screen.getByLabelText(/new password/i), "correct-horse-battery-staple");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser.mock.calls[0][0]).toEqual({
      password: "correct-horse-battery-staple",
    });
  });

  it("stage 2 alt: PASSWORD_RECOVERY event also flips the view to update mode", async () => {
    let handler: ((event: string) => void) | null = null;
    onAuthStateChange.mockImplementation((cb: (event: string) => void) => {
      handler = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    render(<ResetPasswordPage />);

    // Initially in request mode (no ?code, no recovery hash).
    expect(
      screen.getByText(/^reset password$/i),
    ).toBeDefined();

    await act(async () => {
      handler?.("PASSWORD_RECOVERY");
    });

    await waitFor(() =>
      expect(
        screen.getByText(/set a new password/i),
      ).toBeDefined(),
    );
  });
});
