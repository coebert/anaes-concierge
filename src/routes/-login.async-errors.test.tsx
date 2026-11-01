// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const signInWithPassword = vi.fn();
const signInWithOAuth = vi.fn();
const toastError = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ options: opts }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signInWithPassword } } }));
vi.mock("@/integrations/lovable/index", () => ({ lovable: { auth: { signInWithOAuth } } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: false, loading: false }) }));
vi.mock("@/features/passkeys/passkeys.functions", () => ({ listMyPasskeys: vi.fn() }));
vi.mock("@/components/offer-passkey-registration", () => ({ OfferPasskeyRegistration: () => null, shouldOfferPasskey: vi.fn(async () => false) }));
vi.mock("@/components/passkey-login-button", () => ({ PasskeyLoginButton: () => <div>passkey</div> }));
vi.mock("@/components/app-logo", () => ({ AppLogo: () => null }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { Route } from "./login";

const Login = (Route as unknown as { options: { component: () => JSX.Element } }).options.component;

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
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/try again/i)));
    expect(screen.getByRole("button", { name: /^sign in$/i })).not.toBeDisabled();
  });

  it("Google SDK throw clears busy and shows a friendly message", async () => {
    signInWithOAuth.mockRejectedValue(new Error("sdk boom"));
    render(<Login />);
    fireEvent.click(screen.getByRole("button", { name: /google/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/google sign-in/i)));
    expect(screen.getByRole("button", { name: /google/i })).not.toBeDisabled();
  });
});
