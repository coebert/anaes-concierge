// @vitest-environment jsdom
import type React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => cleanup());

const { signInWithPassword, signInWithOAuth, toastError } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ options: opts }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signInWithPassword } } }));
vi.mock("@/integrations/lovable/index", () => ({ lovable: { auth: { signInWithOAuth } } }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ isAuthenticated: false, loading: false }),
}));
vi.mock("@/features/passkeys/passkeys.functions", () => ({ listMyPasskeys: vi.fn() }));
vi.mock("@/components/offer-passkey-registration", () => ({
  OfferPasskeyRegistration: () => null,
  shouldOfferPasskey: vi.fn(async () => false),
}));
vi.mock("@/components/passkey-login-button", () => ({
  PasskeyLoginButton: () => <div>passkey</div>,
}));
vi.mock("@/components/app-logo", () => ({ AppLogo: () => null }));
vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

import { Route } from "./login";

const Login = (Route as unknown as { options: { component: () => React.ReactElement } }).options
  .component;

describe("login async failures", () => {
  beforeEach(() => {
    signInWithPassword.mockReset();
    signInWithOAuth.mockReset();
    toastError.mockReset();
  });

  it("password sign-in network throw clears busy and shows a friendly retry message", async () => {
    signInWithPassword.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<Login />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenough123" } });
    const btn = screen.getByRole("button", { name: /^sign in$/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/try again/i)),
    );
    expect((screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("Google SDK throw clears busy and shows a friendly message", async () => {
    signInWithOAuth.mockRejectedValue(new Error("sdk boom"));
    render(<Login />);
    fireEvent.click(screen.getByRole("button", { name: /google/i }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/google sign-in/i)),
    );
    expect((screen.getByRole("button", { name: /google/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("login connection failure returned as an error result", () => {
  it("shows the friendly connection message, not raw 'Failed to fetch'", async () => {
    signInWithPassword.mockReset();
    toastError.mockReset();
    signInWithPassword.mockResolvedValue({
      data: {},
      error: Object.assign(new Error("Failed to fetch"), {
        name: "AuthRetryableFetchError",
        status: 0,
      }),
    });
    render(<Login />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenough123" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toMatch(/couldn't reach the sign-in service/i);
  });
});
