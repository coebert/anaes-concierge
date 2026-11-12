/**
 * Builds the read-only per-location line (e.g. MRI) shown on the Duties &
 * on-call page. A location list with nobody linked is kept distinct from a
 * day with no list at all, so a blank cell never reads as "covered".
 */
export type LocationHalf = "am" | "pm";

export interface LocationSession {
  id: string;
  session_date: string;
  session: string;
}
export interface LocationAssignment {
  id: string;
  staff_id: string | null;
  theatre_session_id: string | null;
}

export type LocationCell = { kind: "no_list" } | { kind: "list"; staffIds: string[] };

export const LOCATION_HALVES: LocationHalf[] = ["am", "pm"];

export function buildLocationCells(
  sessions: readonly LocationSession[],
  assignments: readonly LocationAssignment[],
): (dateIso: string, half: LocationHalf) => LocationCell {
  const bySession = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (!a.theatre_session_id || !a.staff_id) continue;
    const set = bySession.get(a.theatre_session_id) ?? new Set<string>();
    set.add(a.staff_id);
    bySession.set(a.theatre_session_id, set);
  }
  const byKey = new Map<string, Set<string>>();
  for (const s of sessions) {
    if (s.session !== "am" && s.session !== "pm") continue;
    const key = `${s.session_date}|${s.session}`;
    const set = byKey.get(key) ?? new Set<string>();
    for (const id of bySession.get(s.id) ?? []) set.add(id);
    byKey.set(key, set);
  }
  return (dateIso, half) => {
    const set = byKey.get(`${dateIso}|${half}`);
    return set ? { kind: "list", staffIds: [...set] } : { kind: "no_list" };
  };
}
