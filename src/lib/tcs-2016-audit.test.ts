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

  // Regression: a standard AM+PM weekday merges to exactly 10 h. Under
  // TCS 2016 a "long shift" is one lasting MORE than 10 h, so weeks of
  // normal theatre days must NOT register as consecutive long shifts.
  it("does not flag AM+PM weekdays as long shifts over many weeks", () => {
    const days: string[] = [];
    // 16 weeks of Mon–Fri AM+PM
    const start = new Date(Date.UTC(2026, 0, 5)); // Mon 5 Jan 2026
    for (let w = 0; w < 16; w++) {
      for (let d = 0; d < 5; d++) {
        const day = new Date(start.getTime() + (w * 7 + d) * 86_400_000);
        days.push(day.toISOString().slice(0, 10));
      }
    }
    const a = days.flatMap((d) => [mk(d, "am"), mk(d, "pm")]);
    const r = auditTcs2016(a);
    const longRule = r.rules.find((x) => x.id === "max_5_long");
    expect(longRule?.status).toBe("pass");
    expect(longRule?.detail).toMatch(/: 0$/);
  });

  // Regression: even a genuine long shift (eve appended to AM+PM = 13h)
  // running every weekday must reset its run on the weekend gap rather
  // than accumulating across months.
  it("resets consecutive long-shift run on rest-day gaps", () => {
    const a: AuditAssignment[] = [];
    const start = new Date(Date.UTC(2026, 0, 5)); // Mon 5 Jan 2026
    for (let w = 0; w < 8; w++) {
      for (let d = 0; d < 5; d++) {
        const day = new Date(start.getTime() + (w * 7 + d) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        a.push(mk(day, "am"), mk(day, "pm"), mk(day, "eve"));
      }
    }
    const r = auditTcs2016(a);
    const longRule = r.rules.find((x) => x.id === "max_5_long");
    // 5 long working days each week, gap on weekend → max run is 5.
    expect(longRule?.detail).toMatch(/: 5$/);
    expect(longRule?.status).toBe("pass");
  });

  // Regression: 4 nights then a rest day then 4 more nights must NOT
  // read as 8 consecutive nights.
  it("resets consecutive-nights run on a non-night day", () => {
    const a = [
      mk("2026-05-25", "night"), mk("2026-05-26", "night"),
      mk("2026-05-27", "night"), mk("2026-05-28", "night"),
      // gap day 29 May
      mk("2026-05-30", "night"), mk("2026-05-31", "night"),
      mk("2026-06-01", "night"), mk("2026-06-02", "night"),
    ];
    const r = auditTcs2016(a);
    expect(r.rules.find((x) => x.id === "max_4_nights")?.status).toBe("pass");
  });
});

describe("auditTcs2016 — Phase 1 accuracy improvements", () => {
  it("R8 fires after a single night when next shift is <46h later", () => {
    // Night Mon 21:00 → 08:00 Tue; PM Tue 13:00. Gap = 5h.
    const r = auditTcs2016([
      mk("2026-05-25", "night", "sho_oncall", "on_call"),
      mk("2026-05-26", "pm"),
    ]);
    const rule = r.rules.find((x) => x.id === "rest_46h_post_nights");
    expect(rule?.status).toBe("fail");
    expect(rule?.breaches?.[0].note).toMatch(/1 consecutive night/);
  });

  it("R8 passes after a single night if next shift is ≥46h later", () => {
    // Night Mon 21:00 → 08:00 Tue; AM Thu 08:00. Gap = 48h.
    const r = auditTcs2016([
      mk("2026-05-25", "night", "sho_oncall", "on_call"),
      mk("2026-05-28", "am"),
    ]);
    expect(
      r.rules.find((x) => x.id === "rest_46h_post_nights")?.status,
    ).toBe("pass");
  });

  it("R6 bridges a single leave day in the middle of a stretch", () => {
    // Worked Sat 23 May → Mon 1 Jun, with a leave day on Wed 27 May.
    // Without leave-bridging the run breaks; with bridging it's 10 days.
    const days = [
      "2026-05-23", "2026-05-24", "2026-05-25", "2026-05-26",
      // "2026-05-27" leave
      "2026-05-28", "2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01",
    ];
    const a = days.map((d) => mk(d, "am"));
    const r = auditTcs2016(a, { leaveDates: new Set(["2026-05-27"]) });
    const rule = r.rules.find((x) => x.id === "max_7_consec_days");
    expect(rule?.status).toBe("fail");
    expect(rule?.detail).toMatch(/: 9$/);
  });

  it("R1 uses the supplied window and excludes leave days", () => {
    // Only 1 working week (50h) but reference period is 4 weeks (28 days),
    // 5 of which are leave → denominator = 23 days ≈ 3.29 weeks → still
    // under 4 weeks of contracted time, so this is indeterminate (the
    // safer outcome) rather than spuriously passing as ~12.5 h/week.
    const a = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"]
      .flatMap((d) => [mk(d, "am"), mk(d, "pm")]);
    const leave = new Set([
      "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
    ]);
    const r = auditTcs2016(a, {
      windowStartISO: "2026-05-25",
      windowEndISO: "2026-07-19", // ~8 weeks
      leaveDates: leave,
    });
    const rule = r.rules.find((x) => x.id === "avg_48h");
    expect(rule?.detail).toMatch(/excluded 5 leave days/);
  });
});
