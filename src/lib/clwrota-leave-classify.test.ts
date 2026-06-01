import { describe, it, expect } from "vitest";
import {
  classifyLeaveType,
  classifyLeaveStatus,
  looksLikeProfessionalReason,
} from "./clwrota-leave-classify";
import { summariseStaffLeave, remaining } from "./leave-allowances";

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
    expect(classifyLeaveStatus("Cancelled")).toBe("cancelled");
    expect(classifyLeaveStatus("Withdrawn")).toBe("cancelled");
    expect(classifyLeaveStatus("Pending approval")).toBe("pending");
    expect(classifyLeaveStatus("Awaiting decision")).toBe("pending");
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
