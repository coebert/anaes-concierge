/**
 * Namespaced trace logger for the password-reset / auth-context flow.
 *
 * Emits `console.debug` groups tagged `[auth-trace]` so the whole recovery
 * journey can be replayed from the browser console. Enabled automatically
 * in dev, and in prod when the user sets
 * `sessionStorage.setItem("auth.debug", "1")` (useful when asking a user
 * to reproduce a reset-password issue).
 */

const NS = "[auth-trace]";

function enabled(): boolean {
  if (typeof window === "undefined") return false;
  // Vite exposes DEV at build time; guard for non-vite runtimes.
  const dev =
    typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (dev) return true;
  try {
    return window.sessionStorage.getItem("auth.debug") === "1";
  } catch {
    return false;
  }
}

/** First 8 chars + length — enough to correlate without leaking the full JWT. */
export function fingerprint(token: string | null | undefined): string | null {
  if (!token) return null;
  return `${token.slice(0, 8)}…(${token.length})`;
}

/** Summarise a URL's recovery indicators without dumping raw tokens. */
export function describeRecoveryUrl(href: string): Record<string, unknown> {
  try {
    const u = new URL(href);
    const hashParams = new URLSearchParams(
      u.hash.startsWith("#") ? u.hash.slice(1) : "",
    );
    const pick = (k: string) =>
      u.searchParams.get(k) ?? hashParams.get(k) ?? null;
    return {
      pathname: u.pathname,
      searchKeys: [...u.searchParams.keys()],
      hashKeys: [...hashParams.keys()],
      code: fingerprint(u.searchParams.get("code")),
      token_hash: fingerprint(pick("token_hash")),
      access_token: fingerprint(hashParams.get("access_token")),
      refresh_token: fingerprint(hashParams.get("refresh_token")),
      type: pick("type"),
      error: pick("error"),
      error_code: pick("error_code"),
      error_description: pick("error_description"),
    };
  } catch {
    return { pathname: null, parseError: true };
  }
}

/** Summarise a Supabase session without leaking tokens. */
export function describeSession(
  session: { user?: { id?: string; email?: string | null } | null; access_token?: string; refresh_token?: string; expires_at?: number | null } | null | undefined,
): Record<string, unknown> {
  if (!session) return { present: false };
  return {
    present: true,
    userId: session.user?.id ?? null,
    email: session.user?.email ?? null,
    access_token: fingerprint(session.access_token),
    refresh_token: fingerprint(session.refresh_token),
    expires_at: session.expires_at ?? null,
  };
}

export function trace(event: string, data?: Record<string, unknown>): void {
  if (!enabled()) return;
  // eslint-disable-next-line no-console
  console.debug(NS, event, {
    t: new Date().toISOString(),
    ...(data ?? {}),
  });
}

export function traceError(event: string, err: unknown, data?: Record<string, unknown>): void {
  if (!enabled()) return;
  // eslint-disable-next-line no-console
  console.error(NS, event, {
    t: new Date().toISOString(),
    error: err instanceof Error ? { name: err.name, message: err.message } : err,
    ...(data ?? {}),
  });
}
