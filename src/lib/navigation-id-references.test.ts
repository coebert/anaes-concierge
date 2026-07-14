import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "./navigation";

/**
 * Meta-guard: every nav id referenced in sibling navigation/command-palette
 * tests must exist in NAV_ITEMS. This prevents test files from drifting past
 * navigation refactors (e.g. a menu item is deleted or renamed but a test
 * keeps asserting against the old id) and producing red suites that block
 * unrelated work.
 *
 * The rule is one-directional: tests must not reference ids that are absent
 * from NAV_ITEMS. It is fine for NAV_ITEMS to contain ids that no test
 * references — coverage is not the concern here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// Test files that assert on specific nav ids by string literal. Extend this
// list when adding new navigation-shape tests.
const NAV_ID_TEST_FILES = [
  "audits-menu-snapshot.test.ts",
  "command-palette-staff-group.test.ts",
  "navigation-group-validation.test.ts",
  "navigation-staff-group.test.ts",
];

// A NAV_ITEMS id is a lowercase slug (with or without hyphens) that never
// contains slashes, spaces, or punctuation. Route paths (`"/admin/foo"`),
// keywords with spaces (`"return to work"`), and camelCase identifiers are
// all naturally excluded by this shape.
const ID_TOKEN = /"([a-z][a-z0-9-]*)"/g;

// Slugs that appear in the test sources but are not NAV_ITEMS ids
// (route segments, url paths, group ids, etc.). Add sparingly, with a reason.
const NOT_A_NAV_ID = new Set<string>([
  // Group ids from NavGroupId — checked separately in group-validation tests.
  "audits-robustness",
]);

function collectQuotedSlugs(source: string): Set<string> {
  const out = new Set<string>();
  // Only scan lines that don't look like route paths or css strings.
  for (const match of source.matchAll(ID_TOKEN)) {
    const slug = match[1];
    if (NOT_A_NAV_ID.has(slug)) continue;
    // Skip anything that also appears inside a slash-prefixed path token on
    // the same match — `"/admin/rota-gaps"` yields no match because slashes
    // aren't part of the regex, so path segments never leak through.
    out.add(slug);
  }
  return out;
}

describe("navigation — test files reference only known NAV_ITEMS ids", () => {
  const knownIds = new Set(NAV_ITEMS.map((i) => i.id));

  it("every test file we track actually exists", () => {
    const present = new Set(readdirSync(HERE));
    for (const file of NAV_ID_TEST_FILES) {
      expect(present.has(file), `missing test file: ${file}`).toBe(true);
    }
  });

  it.each(NAV_ID_TEST_FILES)(
    "%s references only ids that exist in NAV_ITEMS",
    (file) => {
      const source = readFileSync(join(HERE, file), "utf8");
      const slugs = collectQuotedSlugs(source);

      // A slug looks like a nav id only if it's the first argument to a
      // NAV_ITEMS lookup or appears in a MOVED_IDS-style list. We heuristically
      // treat any kebab-case string as a candidate and filter by cross-check:
      // if NAV_ITEMS also contains a matching id, that reference must resolve.
      // Anything else (e.g. `"data-lovable"` in a keyword list) is ignored.
      const unknown: string[] = [];
      for (const slug of slugs) {
        // Only flag a slug when it plausibly names a NAV_ITEMS id — i.e. the
        // test uses it in an id-lookup context. We approximate that by
        // requiring the slug to be listed in an array of literal ids or
        // compared to `i.id ===`. Detect via a per-file substring search.
        const isIdContext =
          new RegExp(`\\.id\\s*===\\s*"${slug}"`).test(source) ||
          new RegExp(`\\{\\s*id:\\s*"${slug}"`).test(source) ||
          new RegExp(`byId[^\\n]*\\.get\\("${slug}"\\)`).test(source) ||
          new RegExp(`MOVED_IDS\\s*=\\s*\\[[^\\]]*"${slug}"`).test(source) ||
          new RegExp(`AUDITS_EXPECTED\\s*=\\s*\\[[^\\]]*"${slug}"`).test(source);
        if (!isIdContext) continue;
        if (!knownIds.has(slug)) unknown.push(slug);
      }

      expect(
        unknown,
        `${file} references nav ids missing from NAV_ITEMS: ${unknown.join(", ")}`,
      ).toEqual([]);
    },
  );
});
