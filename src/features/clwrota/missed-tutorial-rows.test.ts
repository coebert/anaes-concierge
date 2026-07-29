import { describe, it, expect } from "vitest";
import { pick, looksLikeTutorialLabel } from "./parsing";
import { isTutorialAuditCandidate } from "./tutorial-audit";
import {
  MISSED_TUTORIAL_ROWS,
  TUTORIAL_TEXT_PICK_KEYS,
} from "./__fixtures__/missed-tutorial-rows";

/**
 * Regression fixtures for the "tutorial audit finds nothing" bug.
 *
 * Each fixture is a real-shaped CLWRota row where the tutorial phrase
 * lived in a field the sync used to ignore (description / activity /
 * topic / title / nested session|shift|assignment variants). Locking
 * these down as first-class tests prevents any future narrowing of the
 * free-text pick list from silently regressing tutorial detection.
 */
describe("missed CLWRota tutorial rows — regression fixtures", () => {
  for (const fx of MISSED_TUTORIAL_ROWS) {
    describe(fx.name, () => {
      it(`pick() surfaces the tutorial text from \`${fx.sourceField}\``, () => {
        const extracted = pick(fx.row, TUTORIAL_TEXT_PICK_KEYS);
        expect(extracted, `no text picked from ${fx.sourceField}`).not.toBeNull();
        expect(extracted!).toContain(fx.expectedNoteContains);
      });

      it("looksLikeTutorialLabel matches once the note is surfaced", () => {
        const note = pick(fx.row, TUTORIAL_TEXT_PICK_KEYS);
        expect(looksLikeTutorialLabel([fx.role, note])).toBe(true);
      });

      it("isTutorialAuditCandidate accepts the post-sync row", () => {
        // Emulate the row shape stored in rota_assignments after sync:
        // - generic role/duty (SPA/Consultant → spa)
        // - notes populated from the free-text pick
        const note = pick(fx.row, TUTORIAL_TEXT_PICK_KEYS);
        expect(
          isTutorialAuditCandidate({
            duty_type: "spa",
            notes: note,
            role_on_list: "admin_session",
          }),
        ).toBe(true);
      });
    });
  }

  it("covers every free-text field we've seen carry tutorial phrases", () => {
    const covered = new Set(MISSED_TUTORIAL_ROWS.map((f) => f.sourceField));
    for (const field of [
      "description",
      "session.description",
      "activity",
      "assignment.activity",
      "topic",
      "session.title",
      "extra_type.description",
    ]) {
      expect(covered, `missing fixture for ${field}`).toContain(field);
    }
  });
});
