/**
 * Global user preference for staff-name list ordering.
 *
 * Stored per-device in localStorage. Every staff list in the app sorts
 * via `compareBySurname`, which reads the current direction from this
 * module's state so a single toggle reorders every list app-wide.
 *
 * When the preference changes:
 *  - module state updates
 *  - the new value is persisted to localStorage
 *  - subscribers (React components using `useNameSortDirection`) are notified
 *  - callers are expected to invalidate any react-query caches so queryFn
 *    sorts re-run with the new direction
 */

import { useSyncExternalStore } from "react";
import { getSurname } from "@/lib/utils";

export type NameSortDirection = "asc" | "desc";

const STORAGE_KEY = "staff-name-sort-direction";
const DEFAULT_DIRECTION: NameSortDirection = "asc";

function hydrate(): NameSortDirection {
  if (typeof window === "undefined") return DEFAULT_DIRECTION;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "desc" ? "desc" : "asc";
  } catch {
    return DEFAULT_DIRECTION;
  }
}

let current: NameSortDirection = hydrate();
const listeners = new Set<() => void>();

export function getNameSortDirection(): NameSortDirection {
  return current;
}

export function setNameSortDirection(direction: NameSortDirection): void {
  if (direction === current) return;
  current = direction;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, direction);
    } catch {
      /* ignore — storage may be unavailable */
    }
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getServerSnapshot(): NameSortDirection {
  return DEFAULT_DIRECTION;
}

/**
 * Subscribe a component to the current name-sort direction so it
 * re-renders when the user toggles the preference.
 */
export function useNameSortDirection(): NameSortDirection {
  return useSyncExternalStore(subscribe, getNameSortDirection, getServerSnapshot);
}

/**
 * Compare two full-name strings by surname, honouring the user's
 * current direction preference (A→Z by default, Z→A when toggled).
 *
 * Use this in every staff-name list sort across the app.
 */
export function compareBySurname(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const aSurname = getSurname(a).toLowerCase();
  const bSurname = getSurname(b).toLowerCase();
  const bySurname = aSurname.localeCompare(bSurname);
  const diff =
    bySurname !== 0
      ? bySurname
      : (a ?? "").toLowerCase().localeCompare((b ?? "").toLowerCase());
  return current === "desc" ? -diff : diff;
}
