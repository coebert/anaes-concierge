/**
 * Pure search-matcher shared by every row type on the global calendar
 * (theatre AM/PM, SPA, Admin, Consultant-in-charge, Obstetrics, ICU,
 * On-call, and NHH 1st On-call). A cell matches when every whitespace-
 * separated token in the query appears (case-insensitively) somewhere
 * in the cell's searchable parts (specialty, surgical consultant,
 * staff names). Empty queries match everything; empty cells stay
 * undimmed unless the query is non-empty.
 */
export function buildSearchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function cellMatchesSearch(
  tokens: string[],
  parts: Array<string | null | undefined>,
): boolean {
  if (tokens.length === 0) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** Convenience: how a row-type cell should render given its search state. */
export function shouldDimCell(
  tokens: string[],
  hasContent: boolean,
  parts: Array<string | null | undefined>,
): boolean {
  if (tokens.length === 0) return false;
  if (!hasContent) return true; // empty cells dim when a query is active
  return !cellMatchesSearch(tokens, parts);
}
