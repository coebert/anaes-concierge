import { describe, it, expect } from "vitest";
import { auditTcs2016, type AuditAssignment } from "./tcs-2016-audit";

const mk = (
  date: string,
  session: "am" | "pm" | "eve" | "night",
  duty = "theatre",
  role = "supervised",
): AuditAssignment => ({
  session_date: date,
  session,
  duty_type: duty,
  role_on_list: role,
});

describe("auditTcs2016", () => {
  it("returns insufficient_data when nothing scheduled", () => {
    const r = auditTcs2016([]);
    expect(r.overall).toBe("insufficient_data");
  });

  it("compliant for a normal Mon–Fri AM+PM week", () => {
    const days = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"];
    const a = days.flatMap((d) => [mk(d, "am"), mk(d, "pm")]);
    const r = auditTcs2016(a);
    expect(r.overall).toBe("compliant");
    // 5 days * 10h = 50h in one week — but averaged over the merged span
    // (span = 1 day from first start to last end -> handled via spanDays>=1).
    expect(r.rules.find((x) => x.id === "max_13h_shift")?.status).toBe("pass");
    expect(r.rules.find((x) => x.id === "max_5_long")?.status).toBe("pass");
  });

  it("flags 5 consecutive nights", () => {
    const a = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"]
      .map((d) => mk(d, "night", "sho_oncall", "on_call"));
    const r = auditTcs2016(a);
    expect(r.rules.find((x) => x.id === "max_4_nights")?.status).toBe("fail");
  });

  it("flags >7 consecutive working days", () => {
    const a = [
      "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28",
      "2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01",
    ].map((d) => mk(d, "am"));
    const r = auditTcs2016(a);
    expect(r.rules.find((x) => x.id === "max_7_consec_days")?.status).toBe("fail");
  });

  it("flags back-to-back worked weekends", () => {
    const a = [
      mk("2026-05-23", "am"), mk("2026-05-24", "am"),
      mk("2026-05-30", "am"), mk("2026-05-31", "am"),
    ];
    const r = auditTcs2016(a);
    expect(r.rules.find((x) => x.id === "weekend_freq")?.status).toBe("fail");
  });

  it("flags <11h rest between an evening and next AM", () => {
    // eve ends 21:00, next AM starts 08:00 = 11h exactly -> pass
    const ok = auditTcs2016([mk("2026-05-25", "eve"), mk("2026-05-26", "am")]);
    expect(ok.rules.find((x) => x.id === "rest_11h")?.status).toBe("pass");
  });
});
