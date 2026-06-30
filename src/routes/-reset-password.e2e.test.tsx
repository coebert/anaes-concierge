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

const {
  resetPasswordForEmail,
  exchangeCodeForSession,
  updateUser,
  setSession,
  verifyOtp,
  getSession,
  onAuthStateChange,
  signOut,
  navigateMock,
  toastSuccess,
  toastError,
} = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  updateUser: vi.fn(),
  setSession: vi.fn(),
  verifyOtp: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
  navigateMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: (_path: string) => (opts: Record<string, unknown>) => ({
      options: opts,
    }),
    useNavigate: () => navigateMock,
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
      setSession: (...args: unknown[]) => setSession(...args),
      verifyOtp: (...args: unknown[]) => verifyOtp(...args),
      getSession: (...args: unknown[]) => getSession(...args),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChange(...args),
      signOut: (...args: unknown[]) => signOut(...args),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
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
  setSession.mockReset().mockResolvedValue({ error: null });
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  getSession.mockReset().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null });
  signOut.mockReset().mockResolvedValue({ error: null });
  navigateMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
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

    const strong = "Correct-Horse-Battery-Staple-9";
    await user.type(screen.getByLabelText(/^new password$/i), strong);
    await user.type(screen.getByLabelText(/confirm new password/i), strong);
    await user.click(screen.getByRole("button", { name: /update password/i }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser.mock.calls[0][0]).toEqual({
      password: strong,
    });
  });

  it("stage 2 alt: implicit recovery hash explicitly sets the session before showing the password form", async () => {
    setLocation("/reset-password#access_token=access-123&refresh_token=refresh-123&type=recovery");

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await waitFor(() =>
      expect(setSession).toHaveBeenCalledWith({
        access_token: "access-123",
        refresh_token: "refresh-123",
      }),
    );
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(screen.getByText(/set a new password/i)).toBeDefined();
  });

  it("stage 2 alt: token_hash recovery links are verified before showing the password form", async () => {
    setLocation("/reset-password?token_hash=hash-123&type=recovery");

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await waitFor(() =>
      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "hash-123", type: "recovery" }),
    );
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByText(/set a new password/i)).toBeDefined();
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

  it("shows an inline expired-link error and lets the user request a new link", async () => {
    const user = userEvent.setup();
    setLocation(
      "/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    const alert = await screen.findByTestId("reset-link-error");
    expect(alert.textContent ?? "").toMatch(/expired/i);

    await user.click(screen.getByRole("button", { name: /request a new reset link/i }));

    // Returns to the request form and clears the error params from the URL.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /send reset link/i })).toBeDefined(),
    );
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
  });

  it("shows an inline error when the PKCE code exchange fails", async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      error: { message: "Invalid code: flow_state_not_found" },
    });
    setLocation("/reset-password?code=bad-code");

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    const alert = await screen.findByTestId("reset-link-error");
    expect(alert.textContent ?? "").toMatch(/no longer valid|invalid/i);
    expect(
      screen.getByRole("button", { name: /request a new reset link/i }),
    ).toBeDefined();
    // The new-password form must NOT appear when the exchange failed.
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
  });

  describe("new password validation", () => {
    async function renderUpdateMode() {
      setLocation("/reset-password?code=pkce-ok");
      await act(async () => {
        render(<ResetPasswordPage />);
      });
      await waitFor(() =>
        expect(screen.getByLabelText(/^new password$/i)).toBeDefined(),
      );
    }

    it("disables submit until the password is strong AND confirmation matches", async () => {
      const user = userEvent.setup();
      await renderUpdateMode();

      const submit = screen.getByRole("button", { name: /update password/i });
      const pw = screen.getByLabelText(/^new password$/i);
      const confirm = screen.getByLabelText(/confirm new password/i);

      // Empty → disabled.
      expect((submit as HTMLButtonElement).disabled).toBe(true);

      // Weak password (no upper, no digit, too short) → still disabled.
      await user.type(pw, "weakpass");
      expect((submit as HTMLButtonElement).disabled).toBe(true);

      // Strong password but no confirmation → still disabled.
      await user.clear(pw);
      await user.type(pw, "StrongPass1");
      expect((submit as HTMLButtonElement).disabled).toBe(true);

      // Mismatched confirmation → disabled + visible mismatch error.
      await user.type(confirm, "StrongPass2");
      expect((submit as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId("confirm-password-error").textContent).toMatch(/do not match/i);

      // Matching confirmation → enabled.
      await user.clear(confirm);
      await user.type(confirm, "StrongPass1");
      expect((submit as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId("confirm-password-error")).toBeNull();

      await user.click(submit);
      await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
      expect(updateUser.mock.calls[0][0]).toEqual({ password: "StrongPass1" });
    });

    it("shows a checklist that reflects each rule's pass/fail state", async () => {
      const user = userEvent.setup();
      await renderUpdateMode();

      const status = (id: string) =>
        screen.getByTestId(`pw-check-${id}`).getAttribute("data-ok");

      // Empty: every rule fails.
      expect(status("len")).toBe("false");
      expect(status("upper")).toBe("false");
      expect(status("lower")).toBe("false");
      expect(status("digit")).toBe("false");

      await user.type(screen.getByLabelText(/^new password$/i), "Abcdefg1");
      expect(status("len")).toBe("true");
      expect(status("upper")).toBe("true");
      expect(status("lower")).toBe("true");
      expect(status("digit")).toBe("true");
    });

    it("does not call updateUser when submit is forced on an invalid password", async () => {
      const user = userEvent.setup();
      await renderUpdateMode();

      // Bypass the disabled button by submitting the form directly via Enter
      // inside the password field. Validation in handleUpdate must still block.
      const pw = screen.getByLabelText(/^new password$/i);
      await user.type(pw, "weakpass{Enter}");

      expect(updateUser).not.toHaveBeenCalled();
  });
  });

  describe("post-update redirect", () => {
    async function renderUpdateMode() {
      setLocation("/reset-password?code=pkce-ok");
      await act(async () => {
        render(<ResetPasswordPage />);
      });
      await waitFor(() =>
        expect(screen.getByLabelText(/^new password$/i)).toBeDefined(),
      );
    }

    it("on successful update: shows a success toast, signs out the recovery session, and redirects to /login", async () => {
      const user = userEvent.setup();
      await renderUpdateMode();

      const strong = "Correct-Horse-Battery-Staple-9";
      await user.type(screen.getByLabelText(/^new password$/i), strong);
      await user.type(screen.getByLabelText(/confirm new password/i), strong);
      await user.click(screen.getByRole("button", { name: /update password/i }));

      await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));

      // Recovery session is torn down so the user must sign in with the new password.
      expect(signOut).toHaveBeenCalledTimes(1);

      // Success message references signing in with the new password.
      expect(toastSuccess).toHaveBeenCalledTimes(1);
      const successMsg = String(toastSuccess.mock.calls[0][0]);
      expect(successMsg).toMatch(/sign in/i);
      expect(successMsg).toMatch(/password/i);

      // Redirect is to /login.
      expect(navigateMock).toHaveBeenCalledWith({ to: "/login" });
      expect(toastError).not.toHaveBeenCalled();
    });

    it("on failed update: shows an error toast and does NOT redirect or sign out", async () => {
      updateUser.mockResolvedValueOnce({ error: { message: "Network down" } });
      const user = userEvent.setup();
      await renderUpdateMode();

      const strong = "Correct-Horse-Battery-Staple-9";
      await user.type(screen.getByLabelText(/^new password$/i), strong);
      await user.type(screen.getByLabelText(/confirm new password/i), strong);
      await user.click(screen.getByRole("button", { name: /update password/i }));

      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(toastError.mock.calls[0][0]).toBe("Network down");
      expect(signOut).not.toHaveBeenCalled();
      expect(navigateMock).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("on missing reset session: shows an inline error and does NOT call updateUser", async () => {
      getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
      const user = userEvent.setup();
      await renderUpdateMode();

      const strong = "Correct-Horse-Battery-Staple-9";
      await user.type(screen.getByLabelText(/^new password$/i), strong);
      await user.type(screen.getByLabelText(/confirm new password/i), strong);
      await user.click(screen.getByRole("button", { name: /update password/i }));

      const alert = await screen.findByTestId("reset-link-error");
      expect(alert.textContent ?? "").toMatch(/expired|new reset link/i);
      expect(updateUser).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
      expect(navigateMock).not.toHaveBeenCalled();
    });
  });
});
