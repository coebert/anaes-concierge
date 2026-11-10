/**
 * Pure procedure-tag detection shared by the Theatre Pressure Forecast
 * (browser) and the CLWRota import (server). No client imports here, so the
 * server sync can use the exact same matcher without pulling in the browser
 * Supabase client.
 *
 * Only explicit whole-word labels are matched — never a surgeon, theatre
 * (room) name or specialty.
 */
export type ProcedureTag = "VRAM" | "DIEP" | "Robotic";
export const PROCEDURE_TAGS: readonly ProcedureTag[] = ["VRAM", "DIEP", "Robotic"];

/** Only the first N characters of any single label are scanned. */
export const TAG_SCAN_MAX_CHARS = 500;

// Bounded on both sides by a non-alphanumeric character (or string edge),
// so "DIEP flap" / "(VRAM)" / "Robot-assisted" match but "diepoxide",
// "vrams", "irobot" and "robotically" do not.
const TAG_RE = /(?<![a-z0-9])(vram|diep|robotics|robotic|robot)(?![a-z0-9])/gi;

export function detectProcedureTags(text: string | null | undefined): ProcedureTag[] {
  if (!text) return [];
  const scanned = text.slice(0, TAG_SCAN_MAX_CHARS);
  const out = new Set<ProcedureTag>();
  for (const m of scanned.matchAll(TAG_RE)) {
    const t = (m[1] ?? "").toLowerCase();
    if (t === "vram") out.add("VRAM");
    else if (t === "diep") out.add("DIEP");
    else out.add("Robotic");
  }
  return PROCEDURE_TAGS.filter((t) => out.has(t));
}

/** Keeps only known tag names, in canonical order (drops anything else). */
export function sanitiseProcedureTags(raw: readonly unknown[] | null | undefined): ProcedureTag[] {
  const set = new Set((raw ?? []).filter((v): v is string => typeof v === "string"));
  return PROCEDURE_TAGS.filter((t) => set.has(t));
}
