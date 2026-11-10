export function normaliseRotaLabelText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "off site" after normaliseRotaLabelText (covers Off-site, Off/Site, OFF SITE).
// Global copy for replace(); the non-global copy is for test() (no lastIndex state).
const OFF_SITE_PHRASE_G = /\boff sites?\b/g;
const OFF_SITE_PHRASE = /\boff sites?\b/;

// Explicit non-working / not-on-a-list markers CLWRota uses in the
// slot/consultant field. "available" / "spare" mean the person is
// rostered to the cover pool rather than allocated to a real list, so the
// row is not a theatre session and should not be counted as one. The token
// "free" is NOT included — list titles use it in surgical descriptors such
// as "Free Flap" or "Free Tissue Transfer", which are real theatre lists.
const BUILT_IN_NON_WORKING =
  /(^|\b)(off|off day|day off|regular day off|ltft day off|not working|available|available clinical|spare|tbc|tba|unallocated|nil)(\b|$)/;

// Leave / rest / absence wording. Consulted ONLY on rows that mention
// "off site": before the off-site fix, the bare "off" inside that phrase
// dropped every such row, so these keep an off-site row that is genuinely
// leave/rest/absence excluded instead of newly importing it. Rows without
// the off-site phrase are unaffected (their behaviour is unchanged).
// Short codes such as "AL"/"SL" are deliberately absent — they collide with
// names ("Al-…") in list titles.
const OFF_SITE_ABSENCE_MARKER =
  /\b(leave|sick|sickness|rest|rest day|zero day|zero hours|holiday|holidays|absent|absence|lieu|toil|maternity|paternity|parental|compassionate|bereavement|non working|nwd|rdo)\b/;

/**
 * CLWRota can emit placeholder rows such as "Off", "Off Day" or
 * "Surgeon: Off Day" in rota/list fields. These are explicit non-working
 * markers, not theatre sessions and not evidence of availability.
 *
 * "Off site" / "Off-site" / "Off/site" describes WHERE a list runs (Laser
 * and other remote locations), not a day off, so only that phrase is
 * neutralised before the built-in markers are tested. Any marker that is
 * independently present — in the same string ("Off site - day off") or in
 * another field of the same row — still drops the row, and on off-site rows
 * leave/rest/absence wording does too.
 */
export function isNonWorkingRotaLabel(
  labels: Array<string | null | undefined>,
  extraTokens: string[] = [],
): boolean {
  const normalisedExtras = extraTokens
    .map((t) => normaliseRotaLabelText(t))
    .filter((t) => t.length > 0);
  const texts = labels.map((label) => normaliseRotaLabelText(label ?? "")).filter(Boolean);
  const rowMentionsOffSite = texts.some((t) => OFF_SITE_PHRASE.test(t));
  return texts.some((text) => {
    const withoutOffSite = text.replace(OFF_SITE_PHRASE_G, " ").replace(/\s+/g, " ").trim();
    if (BUILT_IN_NON_WORKING.test(withoutOffSite)) return true;
    if (rowMentionsOffSite && OFF_SITE_ABSENCE_MARKER.test(withoutOffSite)) return true;
    return normalisedExtras.some((tok) => text.includes(tok));
  });
}

/** Pre-fix rule, kept only so tests/replays can prove which rows changed. */
export function legacyIsNonWorkingRotaLabel(
  labels: Array<string | null | undefined>,
  extraTokens: string[] = [],
): boolean {
  const normalisedExtras = extraTokens
    .map((t) => normaliseRotaLabelText(t))
    .filter((t) => t.length > 0);
  return labels.some((label) => {
    const text = normaliseRotaLabelText(label ?? "");
    if (!text) return false;
    if (BUILT_IN_NON_WORKING.test(text)) return true;
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

export function isNonSagRotaLabel(fields: Array<string | null | undefined>): boolean {
  return fields.some((f) => (f ? NON_SAG_REGEX.test(f) : false));
}
