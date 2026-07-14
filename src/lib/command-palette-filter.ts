/**
 * Normalized filter for the command palette.
 *
 * Goals:
 *  - Case-insensitive.
 *  - Whitespace-insensitive ("leave  fairness" == "leave fairness").
 *  - Punctuation-insensitive so hyphenated variants collapse together
 *    ("wellbeing" == "well-being" == "well being").
 *  - All whitespace-separated query tokens must appear in the haystack
 *    (AND semantics), so "leave fairness" doesn't match "leave forecast".
 *
 * Strategy: strip everything that isn't [a-z0-9] from both sides, split
 * the query on whitespace first so multi-word intent survives, then
 * substring-match each stripped token against the stripped haystack.
 */

const NON_ALNUM = /[^a-z0-9]+/g;

export function normalizeForSearch(input: string): string {
  return input.toLowerCase().replace(NON_ALNUM, "");
}

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(NON_ALNUM, ""))
    .filter(Boolean);
}

/**
 * cmdk-compatible filter: returns 1 when every token in `search` appears
 * (after normalization) inside `value`, otherwise 0. cmdk treats any
 * value > 0 as a match.
 */
export function commandPaletteFilter(value: string, search: string): number {
  const tokens = tokenizeQuery(search);
  if (tokens.length === 0) return 1;
  const hay = normalizeForSearch(value);
  return tokens.every((t) => hay.includes(t)) ? 1 : 0;
}
