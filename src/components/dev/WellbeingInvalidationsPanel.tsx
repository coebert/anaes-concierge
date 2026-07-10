import { useEffect, useState, useSyncExternalStore } from "react";
import {
  clearWellbeingInvalidations,
  getWellbeingInvalidations,
  subscribeWellbeingInvalidations,
} from "@/features/wellbeing/invalidate";

/**
 * Dev-only floating panel that lists the most recent `invalidateWellbeing`
 * triggers so stale-data issues are easier to trace. Renders nothing in
 * production builds — `import.meta.env.DEV` gates the whole component so
 * the module tree-shakes out.
 *
 * Toggle with the pill in the bottom-right corner (persisted to
 * localStorage under `wb-diag-open`). Data comes from the ring buffer in
 * `src/features/wellbeing/invalidate.ts`.
 */
export function WellbeingInvalidationsPanel() {
  if (!import.meta.env.DEV) return null;
  return <PanelInner />;
}

const STORAGE_KEY = "wb-diag-open";

function PanelInner() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      setOpen(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const entries = useSyncExternalStore(
    subscribeWellbeingInvalidations,
    getWellbeingInvalidations,
    getWellbeingInvalidations,
  );

  if (!mounted) return null;

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div
      data-testid="wellbeing-diagnostics-panel"
      className="fixed bottom-3 right-3 z-[1000] font-mono text-xs"
    >
      {open ? (
        <div className="w-[360px] max-h-[50vh] flex flex-col rounded-md border border-border bg-background/95 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="font-semibold text-foreground">
              Wellbeing invalidations{" "}
              <span className="text-muted-foreground">({entries.length})</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearWellbeingInvalidations}
                className="rounded border border-input px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={toggle}
                aria-label="Close diagnostics panel"
                className="rounded border border-input px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
              >
                Hide
              </button>
            </div>
          </div>
          <ol className="flex-1 overflow-auto divide-y divide-border">
            {entries.length === 0 ? (
              <li className="px-3 py-4 text-center text-muted-foreground">
                No invalidations yet.
              </li>
            ) : (
              entries.map((e) => (
                <li
                  key={e.id}
                  data-testid="wellbeing-diagnostics-entry"
                  className="px-3 py-1.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-foreground">{e.key}</span>
                    <time
                      dateTime={e.at}
                      className="text-[10px] text-muted-foreground"
                    >
                      {formatTime(e.at)}
                    </time>
                  </div>
                  <div className="text-muted-foreground truncate">
                    reason: <span className="text-foreground">{e.reason}</span>
                  </div>
                </li>
              ))
            )}
          </ol>
        </div>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className="rounded-full border border-border bg-background/90 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground shadow hover:bg-accent"
        >
          WB diag ({entries.length})
        </button>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return iso;
  }
}
