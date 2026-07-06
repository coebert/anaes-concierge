import { describe, it, expect } from "vitest";
import {
  classifyLeaveType,
  classifyLeaveStatus,
  DEFAULT_LEAVE_STATUS,
  looksLikeProfessionalReason,
} from "./clwrota-leave-classify";
import { summariseStaffLeave, remaining } from "@/features/leave/leave-allowances";

/**
 * Regression tests proving the professional-leave backfill survives a CLWRota
 * sync round-trip.
 *
 * CLWRota only sends a coarse `type` ("Study Leave", "Annual Leave", …). The
 * sync upserts `leave_requests` keyed by `clwrota_external_id`, which means
 * the classifier output OVERWRITES whatever value is currently stored.
 *
 * If we ever stop inspecting the free-text reason here, the next overnight
 * sync would silently revert every backfilled `professional` row back to
 * `study`. These tests pin the behaviour down so that can't happen
 * accidentally.
 */

describe("classifyLeaveType — base mappings", () => {
  it("recognises annual leave variants", () => {
    expect(classifyLeaveType("Annual Leave")).toBe("annual");
    expect(classifyLeaveType("AL")).toBe("annual");
    expect(classifyLeaveType("Holiday")).toBe("annual");
    expect(classifyLeaveType("vacation")).toBe("annual");
  });

  it("recognises study leave variants (with no reason)", () => {
    expect(classifyLeaveType("Study Leave")).toBe("study");
    expect(classifyLeaveType("SL")).toBe("study");
    expect(classifyLeaveType("Conference")).toBe("study");
    expect(classifyLeaveType("Course")).toBe("study");
  });

  it("recognises sick / parental / compassionate", () => {
    expect(classifyLeaveType("Sick")).toBe("sick");
    expect(classifyLeaveType("Illness")).toBe("sick");
    expect(classifyLeaveType("Maternity Leave")).toBe("parental");
    expect(classifyLeaveType("Paternity")).toBe("parental");
    expect(classifyLeaveType("Adoption")).toBe("parental");
    expect(classifyLeaveType("Compassionate")).toBe("compassionate");
    expect(classifyLeaveType("Bereavement")).toBe("compassionate");
  });

  it("falls back to other for empty / unknown labels", () => {
    expect(classifyLeaveType(null)).toBe("other");
    expect(classifyLeaveType("")).toBe("other");
    expect(classifyLeaveType("Jury Service")).toBe("other");
  });
});

describe("classifyLeaveType — professional split (CLWRota backfill safety)", () => {
  it("upgrades 'Study Leave' to professional when the reason describes teaching", () => {
    expect(classifyLeaveType("Study Leave", "Teaching on STIVA")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "Teaching on ALS")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "WASP teaching at Bournemouth")).toBe("professional");
  });

  it("upgrades to professional for faculty / instructor / examiner / organising roles", () => {
    expect(classifyLeaveType("Study Leave", "ALS Faculty Salisbury")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "As a Faculty")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "Faculty for new airway course")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "Instructor on EPALS course at SDH")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "GIC course - ALS instructor")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "Coach to lead Course")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "Organising above course")).toBe("professional");
    expect(classifyLeaveType("Study Leave", "ICM resident conference - part of organising committee")).toBe(
      "professional",
    );
    expect(classifyLeaveType("Course", "post frca teaching")).toBe("professional");
  });

  it("KEEPS as study when attending an instructor course (learner, not teacher)", () => {
    // This was the one false positive in the original backfill — it must
    // remain a learner-style classification on resync.
    expect(classifyLeaveType("Study Leave", "emsb Instructor course")).toBe("study");
    expect(classifyLeaveType("Study Leave", "Salisbury Regional Anaesthesia Course")).toBe("study");
    expect(classifyLeaveType("Study Leave", "Euroanaesthesia conference")).toBe("study");
    expect(classifyLeaveType("Study Leave", "SCRAPA 2026 Revalidation Symposium")).toBe("study");
  });

  it("keeps as study when reason is missing or vague", () => {
    expect(classifyLeaveType("Study Leave", null)).toBe("study");
    expect(classifyLeaveType("Study Leave", "")).toBe("study");
    expect(classifyLeaveType("Study Leave", "SDH")).toBe("study");
  });

  it("respects an explicit upstream 'Professional Leave' label", () => {
    expect(classifyLeaveType("Professional Leave")).toBe("professional");
    expect(classifyLeaveType("Professional Leave", "anything at all")).toBe("professional");
  });

  it("does NOT promote annual leave to professional even if reason mentions teaching", () => {
    // A typo or stray word in an annual-leave reason must not shift the
    // bucket. Annual mappings win.
    expect(classifyLeaveType("Annual Leave", "took the day to prep teaching slides")).toBe(
      "annual",
    );
  });
});

describe("looksLikeProfessionalReason — keyword detection", () => {
  it.each([
    "Teaching on ALS",
    "ALS Faculty Salisbury",
    "Instructor on EPALS",
    "Organising above course",
    "Coach to lead Course",
    "post frca teaching",
    "examiner for FRCA",
    "chairing the committee",
  ])("matches %j", (r) => expect(looksLikeProfessionalReason(r)).toBe(true));

  it.each([
    null,
    "",
    "Holiday",
    "emsb Instructor course",                 // attending, not instructing
    "Salisbury Regional Anaesthesia Course",  // attending
    "SCRAPA 2026 Revalidation Symposium",     // attending
  ])("does not match %j", (r) => expect(looksLikeProfessionalReason(r)).toBe(false));
});

describe("classifyLeaveStatus", () => {
  it("defaults missing/empty status to approved (CLWRota-published)", () => {
    expect(classifyLeaveStatus(null)).toBe("approved");
    expect(classifyLeaveStatus("")).toBe("approved");
    expect(classifyLeaveStatus("   ")).toBe("approved");
  });

  it("maps known status verbs", () => {
    expect(classifyLeaveStatus("Approved")).toBe("approved");
    expect(classifyLeaveStatus("Granted")).toBe("approved");
    expect(classifyLeaveStatus("OK")).toBe("approved");
    expect(classifyLeaveStatus("Rejected")).toBe("rejected");
    expect(classifyLeaveStatus("Declined")).toBe("rejected");
    expect(classifyLeaveStatus("Denied")).toBe("rejected");
    expect(classifyLeaveStatus("Cancelled")).toBe("cancelled");
    expect(classifyLeaveStatus("Withdrawn")).toBe("cancelled");
    expect(classifyLeaveStatus("Pending approval")).toBe("pending");
    expect(classifyLeaveStatus("Awaiting decision")).toBe("pending");
  });

  it("normalizes case, whitespace and surrounding punctuation", () => {
    expect(classifyLeaveStatus("  APPROVED  ")).toBe("approved");
    expect(classifyLeaveStatus("approved.")).toBe("approved");
    expect(classifyLeaveStatus("[Approved]")).toBe("approved");
    expect(classifyLeaveStatus("approved\t\n")).toBe("approved");
    expect(classifyLeaveStatus("  CANCELLED!  ")).toBe("cancelled");
    expect(classifyLeaveStatus("  pending...  ")).toBe("pending");
  });

  it("recognises extended approved synonyms", () => {
    expect(classifyLeaveStatus("Authorised")).toBe("approved");
    expect(classifyLeaveStatus("Authorized")).toBe("approved");
    expect(classifyLeaveStatus("Accepted")).toBe("approved");
    expect(classifyLeaveStatus("Confirmed")).toBe("approved");
    expect(classifyLeaveStatus("Signed off")).toBe("approved");
    expect(classifyLeaveStatus("Yes")).toBe("approved");
    expect(classifyLeaveStatus("Okay")).toBe("approved");
  });

  it("recognises extended rejected synonyms (including negations)", () => {
    expect(classifyLeaveStatus("Refused")).toBe("rejected");
    expect(classifyLeaveStatus("Reject")).toBe("rejected");
    expect(classifyLeaveStatus("Not approved")).toBe("rejected");
    expect(classifyLeaveStatus("Not granted")).toBe("rejected");
    expect(classifyLeaveStatus("Not authorised")).toBe("rejected");
    expect(classifyLeaveStatus("No")).toBe("rejected");
  });

  it("recognises extended cancelled synonyms", () => {
    expect(classifyLeaveStatus("Cancel")).toBe("cancelled");
    expect(classifyLeaveStatus("Canceled")).toBe("cancelled"); // US spelling
    expect(classifyLeaveStatus("Withdraw")).toBe("cancelled");
    expect(classifyLeaveStatus("Void")).toBe("cancelled");
    expect(classifyLeaveStatus("Voided")).toBe("cancelled");
    expect(classifyLeaveStatus("Revoked")).toBe("cancelled");
    expect(classifyLeaveStatus("Removed")).toBe("cancelled");
    expect(classifyLeaveStatus("Deleted")).toBe("cancelled");
  });

  it("recognises extended pending synonyms", () => {
    expect(classifyLeaveStatus("Requested")).toBe("pending");
    expect(classifyLeaveStatus("Submitted")).toBe("pending");
    expect(classifyLeaveStatus("In review")).toBe("pending");
    expect(classifyLeaveStatus("Under review")).toBe("pending");
    expect(classifyLeaveStatus("TBC")).toBe("pending");
    expect(classifyLeaveStatus("TBD")).toBe("pending");
    expect(classifyLeaveStatus("Unconfirmed")).toBe("pending");
    expect(classifyLeaveStatus("Open")).toBe("pending");
  });

  it("negation beats the bare verb (precedence)", () => {
    // Must NOT classify these as approved just because the word appears.
    expect(classifyLeaveStatus("not approved")).toBe("rejected");
    expect(classifyLeaveStatus("NOT GRANTED")).toBe("rejected");
    expect(classifyLeaveStatus("  not   authorised  ")).toBe("rejected");
  });
});

describe("end-to-end: CLWRota sync → allowance balances stay correct after backfill", () => {
  // Simulate a CLWRota payload as a list of (typeRaw, reason, start, end) tuples
  // for one staff member, then push them through the classifier and the
  // allowance aggregator — exactly what the live sync + Allowances tab does.
  const STAFF = "staff-1";
  const YEAR_START = "2026-04-01";

  const payload: Array<[string, string | null, string, string]> = [
    // Genuine study (attended a course)
    ["Study Leave", "Salisbury Regional Anaesthesia Course", "2026-04-06", "2026-04-08"], // 3 wd
    ["Study Leave", null, "2026-05-04", "2026-05-04"],                                     // 1 wd
    // Backfill targets — these MUST land in 'professional' on resync
    ["Study Leave", "Teaching on STIVA", "2026-06-08", "2026-06-08"],                       // 1 wd
    ["Study Leave", "ALS Faculty Salisbury", "2026-07-13", "2026-07-14"],                   // 2 wd
    ["Study Leave", "Organising above course", "2026-08-10", "2026-08-10"],                 // 1 wd
    // Edge: instructor course = learner → stays study
    ["Study Leave", "emsb Instructor course", "2026-09-07", "2026-09-07"],                  // 1 wd
    // Other types feed their own buckets
    ["Annual Leave", "Holiday with family", "2026-10-05", "2026-10-09"],                    // 5 wd
    ["Sick", "Flu", "2026-11-02", "2026-11-02"],                                             // 1 wd
  ];

  const rows = payload.map(([typeRaw, reason, start, end], i) => ({
    staff_id: STAFF,
    type: classifyLeaveType(typeRaw, reason),
    status: classifyLeaveStatus(null), // CLWRota-published → approved
    start_date: start,
    end_date: end,
    half_day_start: null,
    half_day_end: null,
    // unused by aggregator, but realistic
    clwrota_external_id: `ext-${i}`,
  }));

  const summary = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);

  it("routes 3 professional rows totalling 4 working days into the professional bucket", () => {
    expect(summary.professional.taken).toBe(4);
    expect(summary.professional.booked).toBe(0);
  });

  it("leaves 3 genuine-study rows (5 working days) in the study bucket", () => {
    expect(summary.study.taken).toBe(5); // 3 + 1 (no-reason) + 1 (instructor course)
    expect(summary.study.booked).toBe(0);
  });

  it("does not double-count: study + professional equals total learning-leave days", () => {
    expect(summary.study.taken + summary.professional.taken).toBe(9);
  });

  it("keeps annual and other (sick) buckets independent", () => {
    expect(summary.annual.taken).toBe(5);
    expect(summary.other.taken).toBe(1);
  });

  it("computes remaining days against default allowances correctly", () => {
    expect(remaining(summary.annualAllowance, summary.annual)).toBe(27 - 5);
    expect(remaining(summary.studyAllowance, summary.study)).toBe(10 - 5);
    expect(remaining(summary.professionalAllowance, summary.professional)).toBe(5 - 4);
  });

  it("is idempotent: re-running the same payload yields identical balances", () => {
    // Re-classify the exact same payload (simulating the next nightly sync).
    const rows2 = payload.map(([typeRaw, reason, start, end], i) => ({
      staff_id: STAFF,
      type: classifyLeaveType(typeRaw, reason),
      status: classifyLeaveStatus(null),
      start_date: start,
      end_date: end,
      half_day_start: null,
      half_day_end: null,
      clwrota_external_id: `ext-${i}`,
    }));
    const s2 = summariseStaffLeave(STAFF, rows2, undefined, YEAR_START);
    expect(s2.professional).toEqual(summary.professional);
    expect(s2.study).toEqual(summary.study);
    expect(s2.annual).toEqual(summary.annual);
    expect(s2.other).toEqual(summary.other);
  });
});

/**
 * Large fixture-driven sweep of real-world CLWRota status strings.
 *
 * These mirror the kinds of values we have actually observed (or expect to
 * observe) in the upstream feed: different casing, surrounding punctuation,
 * stray whitespace/symbols, trailing approver names, and common synonyms.
 * Each entry is a single source-of-truth assertion that the classifier
 * normalises and maps consistently — if any of these flips, an entire
 * category of inputs has silently drifted.
 */
describe("classifyLeaveStatus — real-world fixture sweep", () => {
  type Status = ReturnType<typeof classifyLeaveStatus>;
  const fixtures: Array<[string, Status]> = [
    // --- approved: casing + punctuation ---
    ["Approved", "approved"],
    ["APPROVED", "approved"],
    ["approved", "approved"],
    ["  approved  ", "approved"],
    ["approved.", "approved"],
    ["approved!", "approved"],
    ["[Approved]", "approved"],
    ["(approved)", "approved"],
    ["approved\t\n", "approved"],
    ["approved ✓", "approved"],
    ["approved — Dr Smith", "approved"],
    ["approved by Dr. Smith", "approved"],
    ["approved/confirmed", "approved"],
    // --- approved: synonyms ---
    ["Granted", "approved"],
    ["GRANTED.", "approved"],
    ["granted ✓", "approved"],
    ["Accepted", "approved"],
    ["accepted.", "approved"],
    ["Confirmed", "approved"],
    ["CONFIRMED!", "approved"],
    ["Authorised", "approved"],
    ["AUTHORIZED", "approved"],
    ["authorised.", "approved"],
    ["Signed off", "approved"],
    ["signed-off", "approved"],
    ["Signed Off.", "approved"],
    ["OK", "approved"],
    ["ok!", "approved"],
    ["Ok.", "approved"],
    ["Okay", "approved"],
    ["Okay :)", "approved"],
    ["Yes", "approved"],
    ["YES", "approved"],
    ["yes - confirmed", "approved"],

    // --- rejected: casing + punctuation ---
    ["Rejected", "rejected"],
    ["REJECTED!", "rejected"],
    ["rejected.", "rejected"],
    ["[rejected]", "rejected"],
    ["  rejected  ", "rejected"],
    // --- rejected: synonyms ---
    ["Declined", "rejected"],
    ["DECLINED", "rejected"],
    ["declined.", "rejected"],
    ["Denied", "rejected"],
    ["denied.", "rejected"],
    ["Denied!", "rejected"],
    ["Refused", "rejected"],
    ["refused.", "rejected"],
    ["No", "rejected"],
    ["NO!", "rejected"],
    ["no.", "rejected"],
    // --- rejected: negations (must beat 'approved') ---
    ["Not approved", "rejected"],
    ["NOT APPROVED", "rejected"],
    ["not approved.", "rejected"],
    ["not-approved", "rejected"],
    ["Not granted.", "rejected"],
    ["not authorised", "rejected"],
    ["NOT AUTHORIZED", "rejected"],
    ["not accepted", "rejected"],

    // --- cancelled: casing + punctuation ---
    ["Cancelled", "cancelled"],
    ["CANCELLED!", "cancelled"],
    ["cancelled.", "cancelled"],
    ["  cancelled  ", "cancelled"],
    ["Canceled", "cancelled"],
    ["canceled.", "cancelled"],
    // --- cancelled: synonyms ---
    ["Withdrawn", "cancelled"],
    ["WITHDRAWN", "cancelled"],
    ["withdrawn.", "cancelled"],
    ["Withdraw", "cancelled"],
    ["Void", "cancelled"],
    ["Voided", "cancelled"],
    ["void.", "cancelled"],
    ["Revoked", "cancelled"],
    ["revoked!", "cancelled"],
    ["Removed", "cancelled"],
    ["removed.", "cancelled"],
    ["Deleted", "cancelled"],
    ["DELETED", "cancelled"],

    // --- pending: casing + punctuation ---
    ["Pending", "pending"],
    ["PENDING", "pending"],
    ["pending.", "pending"],
    ["  pending...  ", "pending"],
    ["Pending approval", "pending"],
    ["pending review", "pending"],
    // --- pending: synonyms ---
    ["Awaiting", "pending"],
    ["Awaiting approval", "pending"],
    ["awaiting decision", "pending"],
    ["Requested", "pending"],
    ["REQUESTED!", "pending"],
    ["Request.", "pending"],
    ["Submitted", "pending"],
    ["submitted.", "pending"],
    ["SUBMITTED", "pending"],
    ["In review", "pending"],
    ["in-review", "pending"],
    ["IN REVIEW", "pending"],
    ["Under review", "pending"],
    ["TBC", "pending"],
    ["tbc.", "pending"],
    ["Tbc", "pending"],
    ["TBD", "pending"],
    ["TBD!", "pending"],
    ["Unconfirmed", "pending"],
    ["unconfirmed.", "pending"],
    ["Open", "pending"],
    ["OPEN", "pending"],
    ["open.", "pending"],

    // --- empty / whitespace / pure-punct → default approved
    //     (CLWRota only publishes approved leave) ---
    ["", "approved"],
    ["   ", "approved"],
    ["\t\n", "approved"],
    ["...", "approved"],
    ["—", "approved"],
  ];

  it.each(fixtures)("maps %j → %s", (input, expected) => {
    expect(classifyLeaveStatus(input)).toBe(expected);
  });

  it("never returns an unexpected value across the entire fixture set", () => {
    const allowed: Status[] = ["approved", "pending", "rejected", "cancelled"];
    for (const [input] of fixtures) {
      expect(allowed).toContain(classifyLeaveStatus(input));
    }
  });
});

describe("classifyLeaveStatus — unknown / unrecognised strings fall back consistently", () => {
  it("maps every unknown string to the explicit default", () => {
    const unknowns = [
      "qwerty",
      "12345",
      "!@#$%",
      "lorem ipsum",
      "foo bar baz",
      "unknown",
      "unrecognised",
      "random text here",
      "xyzabc",
      "status undefined",
      "n/a",
      "na",
      "---",
      "???",
      "🚀",
      "日本語",
      "한글",
      "العربية",
    ];
    for (const s of unknowns) {
      expect(classifyLeaveStatus(s)).toBe(DEFAULT_LEAVE_STATUS);
    }
  });

  it("maps a string of pure whitespace / symbols to the explicit default", () => {
    expect(classifyLeaveStatus("   \t\n\r   ")).toBe(DEFAULT_LEAVE_STATUS);
    expect(classifyLeaveStatus("!!!")).toBe(DEFAULT_LEAVE_STATUS);
    expect(classifyLeaveStatus("...")).toBe(DEFAULT_LEAVE_STATUS);
  });

  it("does not silently change the default value", () => {
    // If this assertion ever fails, the fallback policy has been altered
    // intentionally or accidentally.  Update the test AND the JSDoc on
    // DEFAULT_LEAVE_STATUS to reflect the new policy.
    expect(DEFAULT_LEAVE_STATUS).toBe("approved");
  });
});

/**
 * Targeted coverage for UK admin language variants and common non-English
 * status words seen on real CLWRota imports (NHS rotas occasionally include
 * staff pasting from French / German / Spanish / Italian / Polish / Welsh
 * HR tooling).  Keep this list deliberately small — it documents the
 * tokens we have agreed to support, not every conceivable translation.
 */
describe("classifyLeaveStatus — UK admin phrases & non-English variants", () => {
  type Status = ReturnType<typeof classifyLeaveStatus>;

  const ukAdminFixtures: Array<[string, Status]> = [
    // Approved — UK admin synonyms
    ["Agreed", "approved"],
    ["agreed by rota lead", "approved"],
    ["Sanctioned", "approved"],
    ["Endorsed by clinical director", "approved"],
    ["Ratified at JLNC", "approved"],
    ["Cleared", "approved"],
    ["Permitted", "approved"],
    ["Allowed", "approved"],
    ["Passed", "approved"],
    ["Signed off — Dr. Smith", "approved"],

    // Rejected — UK admin synonyms & multi-word
    ["Turned down", "rejected"],
    ["turned down by HR", "rejected"],
    ["Knocked back", "rejected"],
    ["Sent back", "rejected"],
    ["Not going ahead", "rejected"],
    ["Vetoed", "rejected"],
    ["Blocked", "rejected"],
    ["Disallowed", "rejected"],
    ["Dismissed", "rejected"],
    ["Not permitted", "rejected"],
    ["Not allowed", "rejected"],
    ["Not sanctioned", "rejected"],
    ["Not agreed", "rejected"],

    // Cancelled — UK admin synonyms
    ["Rescinded", "cancelled"],
    ["Scrapped", "cancelled"],
    ["Abandoned", "cancelled"],
    ["Called off", "cancelled"],
    ["Pulled from rota", "cancelled"],
    ["Rolled back", "cancelled"],

    // Pending — UK admin phrases
    ["On hold", "pending"],
    ["For review", "pending"],
    ["Under consideration", "pending"],
    ["Awaiting approval", "pending"],
    ["Awaiting authorisation", "pending"],
    ["awaiting sign-off", "pending"],
    ["Awaiting sign off", "pending"],
    ["Awaiting decision", "pending"],
    ["With HR", "pending"],
    ["with manager", "pending"],
    ["With line manager", "pending"],
    ["With rota", "pending"],
    ["With admin", "pending"],
    ["To be confirmed", "pending"],
    ["To be decided", "pending"],
    ["In the queue", "pending"],
    ["Outstanding", "pending"],
    ["Queued", "pending"],
  ];

  const nonEnglishFixtures: Array<[string, Status]> = [
    // French
    ["Approuvé", "approved"],
    ["approuvée", "approved"],
    ["Accepté", "approved"],
    ["Validé", "approved"],
    ["Refusé", "rejected"],
    ["rejetée", "rejected"],
    ["Annulé", "cancelled"],
    ["annulée", "cancelled"],
    ["En attente", "pending"],
    ["En cours", "pending"],

    // German
    ["Genehmigt", "approved"],
    ["Bewilligt", "approved"],
    ["Zugestimmt", "approved"],
    ["Abgelehnt", "rejected"],
    ["Verweigert", "rejected"],
    ["Storniert", "cancelled"],
    ["Abgesagt", "cancelled"],
    ["Ausstehend", "pending"],
    ["In Bearbeitung", "pending"],

    // Spanish
    ["Aprobado", "approved"],
    ["Aprobada", "approved"],
    ["Aceptado", "approved"],
    ["Rechazado", "rejected"],
    ["Denegado", "rejected"],
    ["Cancelado", "cancelled"],
    ["Anulado", "cancelled"],
    ["Pendiente", "pending"],
    ["En espera", "pending"],
    ["En revisión", "pending"],

    // Italian
    ["Approvato", "approved"],
    ["Accettato", "approved"],
    ["Rifiutato", "rejected"],
    ["Respinto", "rejected"],
    ["Annullato", "cancelled"],
    ["In attesa", "pending"],
    ["In sospeso", "pending"],

    // Polish
    ["Zatwierdzony", "approved"],
    ["Zaakceptowany", "approved"],
    ["Odrzucony", "rejected"],
    ["Odmowa", "rejected"],
    ["Anulowany", "cancelled"],
    ["Wycofany", "cancelled"],
    ["Oczekujące", "pending"],
    ["W trakcie", "pending"],

    // Welsh
    ["Cymeradwyo", "approved"],
    ["Cymeradwywyd", "approved"],
    ["Derbyniwyd", "approved"],
    ["Gwrthod", "rejected"],
    ["Gwrthodwyd", "rejected"],
    ["Diddymwyd", "cancelled"],
    ["Yn aros", "pending"],
  ];

  it.each(ukAdminFixtures)(
    "UK admin: %s → %s",
    (input, expected) => {
      expect(classifyLeaveStatus(input)).toBe(expected);
    },
  );

  it.each(nonEnglishFixtures)(
    "non-English: %s → %s",
    (input, expected) => {
      expect(classifyLeaveStatus(input)).toBe(expected);
    },
  );

  it("treats non-English variants case- and punctuation-insensitively", () => {
    expect(classifyLeaveStatus("  APPROUVÉ.  ")).toBe("approved");
    expect(classifyLeaveStatus("** Abgelehnt! **")).toBe("rejected");
    expect(classifyLeaveStatus("[anulowany]")).toBe("cancelled");
    expect(classifyLeaveStatus("  en   attente  ")).toBe("pending");
  });

  it("UK negation phrases beat the bare approved verb inside them", () => {
    // Guard against regression: 'not sanctioned' must NOT match 'sanctioned'.
    expect(classifyLeaveStatus("Not sanctioned")).toBe("rejected");
    expect(classifyLeaveStatus("Not permitted")).toBe("rejected");
    expect(classifyLeaveStatus("Not allowed")).toBe("rejected");
    expect(classifyLeaveStatus("Not agreed")).toBe("rejected");
  });
});
