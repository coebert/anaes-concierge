/**
 * Automatic cache-busting for stale build artifacts.
 *
 * Detects symptoms of stale chunks (dynamic import failures, ChunkLoadError,
 * unexpected SyntaxError from script execution) and forces a one-time hard
 * reload with a cache-busting query param. A sessionStorage flag prevents
 * reload loops if the error is not actually caused by stale caches.
 */

const RELOAD_FLAG = "__lovable_cache_bust_reloaded";
const RELOAD_PARAM = "__cb";

function isStaleArtifactError(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("failed to fetch dynamically imported module") ||
    m.includes("error loading dynamically imported module") ||
    m.includes("importing a module script failed") ||
    m.includes("chunkloaderror") ||
    m.includes("loading chunk") ||
    m.includes("loading css chunk") ||
    // Stale JS often surfaces as a parse error in a previously-valid bundle
    (m.includes("unexpected token") && m.includes("expected"))
  );
}

function hardReload(): void {
  if (typeof window === "undefined") return;
  try {
    if (sessionStorage.getItem(RELOAD_FLAG) === "1") {
      // Already tried once this session — don't loop.
      return;
    }
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    // sessionStorage unavailable — proceed without loop guard.
  }

  // Best-effort: clear Cache Storage (service worker caches) before reload.
  if ("caches" in window) {
    void caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .catch(() => undefined);
  }

  const url = new URL(window.location.href);
  url.searchParams.set(RELOAD_PARAM, Date.now().toString(36));
  window.location.replace(url.toString());
}

let installed = false;

export function installCacheBuster(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // Clear the loop-guard flag once the app has successfully booted past install.
  // We defer slightly so a crash during initial render still counts as "failed".
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      // ignore
    }
  }, 10_000);

  window.addEventListener("error", (event) => {
    const msg = event?.message || (event?.error && String(event.error.message || event.error)) || "";
    if (isStaleArtifactError(msg)) {
      hardReload();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event?.reason;
    const msg =
      typeof reason === "string"
        ? reason
        : reason && typeof reason === "object" && "message" in reason
          ? String((reason as { message?: unknown }).message ?? "")
          : "";
    if (isStaleArtifactError(msg)) {
      hardReload();
    }
  });
}

/** Exposed for the error boundary — checks an error and reloads if it looks stale. */
export function maybeCacheBust(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (isStaleArtifactError(msg)) {
    hardReload();
    return true;
  }
  return false;
}
