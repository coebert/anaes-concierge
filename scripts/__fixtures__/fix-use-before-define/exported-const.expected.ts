// Exported const used before declaration — the most common TS2304 we hit.

export const DEFAULT_RULES = { maxHours: 48 };
export function build() {
  return { rules: DEFAULT_RULES };
}
