/**
 * Remember-me semantics on top of Supabase's localStorage-backed session.
 *
 * The generated Supabase client persists the session in `localStorage`, which
 * survives browser restarts. To support an opt-out ("don't keep me signed in"),
 * we drop a marker in `sessionStorage` on every load — that storage is wiped
 * when the browser/tab is closed. If the user previously chose NOT to be
 * remembered AND the marker is missing on the next load, we treat it as a
 * fresh browser session and sign them out before any UI renders.
 */

const REMEMBER_KEY = "auth.rememberMe";
const SESSION_MARKER_KEY = "auth.sessionMarker";

export function getRememberMe(): boolean {
  if (typeof window === "undefined") return true;
  // Default to true (preserve existing behaviour for users who never toggled it).
  return window.localStorage.getItem(REMEMBER_KEY) !== "false";
}

export function setRememberMe(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REMEMBER_KEY, value ? "true" : "false");
}

/**
 * Returns true if the current browser session is "fresh" AND the user opted out
 * of remember-me — in which case the caller should sign the user out.
 * Always (re)sets the session marker so subsequent reloads within the same
 * browser session are treated as the same session.
 */
export function shouldDropSessionOnLoad(): boolean {
  if (typeof window === "undefined") return false;
  const hasMarker = window.sessionStorage.getItem(SESSION_MARKER_KEY) === "1";
  // Place the marker for future loads regardless.
  try {
    window.sessionStorage.setItem(SESSION_MARKER_KEY, "1");
  } catch {
    // sessionStorage may be unavailable in some contexts; fall through.
  }
  if (hasMarker) return false;
  return !getRememberMe();
}
