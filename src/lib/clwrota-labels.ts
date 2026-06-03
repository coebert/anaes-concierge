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
    // slot/consultant field. "available" / "spare" / "free" mean the person
    // is rostered to the cover pool rather than allocated to a real list,
    // so the row is not a theatre session and should not be counted as one.
    if (/(^|\b)(off|off day|day off|regular day off|ltft day off|not working|available|available clinical|spare|free|tbc|tba|unallocated|nil)(\b|$)/.test(text)) {
      return true;
    }
    return normalisedExtras.some((tok) => text.includes(tok));
  });
}