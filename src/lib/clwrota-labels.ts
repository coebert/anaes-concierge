export function normaliseRotaLabelText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * CLWRota can emit placeholder rows such as "Off", "Off Day" or
 * "Surgeon: Off Day" in rota/list fields. These are explicit non-working
 * markers, not theatre sessions and not evidence of availability.
 */
export function isNonWorkingRotaLabel(
  labels: Array<string | null | undefined>,
  extraTokens: string[] = [],
): boolean {
  const normalisedExtras = extraTokens
    .map((t) => normaliseRotaLabelText(t))
    .filter((t) => t.length > 0);
  return labels.some((label) => {
    const text = normaliseRotaLabelText(label ?? "");
    if (!text) return false;
    // Explicit non-working / not-on-a-list markers CLWRota uses in the
    // slot/consultant field. "available" / "spare" mean the person is
    // rostered to the cover pool rather than allocated to a real list,
    // so the row is not a theatre session and should not be counted as
    // one. Note: the token "free" is NOT included — CLWRota list titles
    // frequently use it in surgical descriptors such as "Free Flap",
    // "Free Fluid" or "Free Tissue Transfer", which are real theatre
    // lists, not non-working markers.
    if (/(^|\b)(off|off day|day off|regular day off|ltft day off|not working|available|available clinical|spare|tbc|tba|unallocated|nil)(\b|$)/.test(text)) {
      return true;
    }
    return normalisedExtras.some((tok) => text.includes(tok));
  });
}
/**
 * CLWRota tags NHH-style lists covered as part of NHS job plans with a
 * "[Non-SAG]" marker appended to free-text fields (person.rota_name,
 * slot_titles, role, theatre, specialty). The tag varies in casing,
 * separator ("non-sag", "non sag", "NON_SAG") and enclosing punctuation
 * ("[Non-SAG]", "(non sag)", "Dr X - Non-SAG", "List 1 NonSAG cover").
 *
 * Returns true when any of the provided fields carries the marker as a
 * standalone token. Plain words containing the substring "sag" (e.g.
 * "saga", "sagittal") must NOT match — the regex enforces word boundaries
 * around the whole "non-sag" token.
 */
const NON_SAG_REGEX = /\bnon[\s\-_]?sag\b/i;

export function isNonSagRotaLabel(
  fields: Array<string | null | undefined>,
): boolean {
  return fields.some((f) => (f ? NON_SAG_REGEX.test(f) : false));
}
