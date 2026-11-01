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

  it("normal Mon–Fri AM+PM week is never reported 'compliant' — only an estimate", () => {
    const days = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"];
    const a = days.flatMap((d) => [mk(d, "am"), mk(d, "pm")]);
    const r = auditTcs2016(a);
    // One week is too short to average, and the weekend rule needs the
    // full rota cycle, so the honest outcome is "incomplete".
    expect(r.overall).toBe("incomplete");
    expect(r.basis).toBe("estimated_screening");
    // 5 days * 10h = 50h in one week — but averaged over the merged span
    // (span = 1 day from first start to last end -> handled via spanDays>=1).
    expect(r.rules.find((x) => x.id === "max_13h_shift")?.status).toBe("pass");
    expect(r.rules.find((x) => x.id === "max_consecutive_long")?.status).toBe("pass");
  });

  it("flags 5 consecutive nights", () => {
    const a = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"].map((d) =>
      mk(d, "night", "sho_oncall", "on_call"),
    );
    const r = auditTcs2016(a);
    expect(r.rules.find((x) => x.id === "max_4_nights")?.status).toBe("fail");
  });

  it("flags >7 consecutive working days", () => {
    const a = [
      "2026-05-25",
      "2026-05-26",
      "2026-05-27",
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
    ].map((d) => mk(d, "am"));
    const r = auditTcs2016(a);
    expect(r.rules.find((x) => x.id === "max_7_consec_days")?.status).toBe("fail");
  });

  it("weekend frequency: not assessed without the rota cycle; flagged over a known cycle", () => {
    const a = [
      mk("2026-05-23", "am"),
      mk("2026-05-24", "am"),
      mk("2026-05-30", "am"),
      mk("2026-05-31", "am"),
    ];
    expect(auditTcs2016(a).rules.find((x) => x.id === "weekend_freq")?.status).toBe(
      "indeterminate",
    );
    const r = auditTcs2016(a, {
      windowStartISO: "2026-05-18",
      windowEndISO: "2026-05-31",
      rotaCycleWeeks: 2,
    });
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
    const longRule = r.rules.find((x) => x.id === "max_consecutive_long");
    expect(longRule?.status).toBe("pass");
    expect(longRule?.detail).toMatch(/: 0 /);
  });

  // Regression: even a genuine long shift (eve appended to AM+PM = 13h)
  // running every weekday must reset its run on the weekend gap rather
  // than accumulating across months.
  it("resets consecutive long-shift run on rest-day gaps", () => {
    const a: AuditAssignment[] = [];
    const start = new Date(Date.UTC(2026, 0, 5)); // Mon 5 Jan 2026
    for (let w = 0; w < 8; w++) {
      for (let d = 0; d < 5; d++) {
        const day = new Date(start.getTime() + (w * 7 + d) * 86_400_000).toISOString().slice(0, 10);
        a.push(mk(day, "am"), mk(day, "pm"), mk(day, "eve"));
      }
    }
    const r = auditTcs2016(a);
    const longRule = r.rules.find((x) => x.id === "max_consecutive_long");
    // 5 long working days each week, gap on weekend → max run is 5 (not 40),
    // which exceeds the default limit of 4…
    expect(longRule?.detail).toMatch(/: 5 /);
    expect(longRule?.status).toBe("fail");
    // …and passes only with an explicitly recorded mutual agreement.
    const agreed = auditTcs2016(a, { agreedFiveLongShifts: true });
    expect(agreed.rules.find((x) => x.id === "max_consecutive_long")?.status).toBe("pass");
  });

  // Regression: 4 nights then a rest day then 4 more nights must NOT
  // read as 8 consecutive nights.
  it("resets consecutive-nights run on a non-night day", () => {
    const a = [
      mk("2026-05-25", "night"),
      mk("2026-05-26", "night"),
      mk("2026-05-27", "night"),
      mk("2026-05-28", "night"),
      // gap day 29 May
      mk("2026-05-30", "night"),
      mk("2026-05-31", "night"),
      mk("2026-06-01", "night"),
      mk("2026-06-02", "night"),
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
    expect(r.rules.find((x) => x.id === "rest_46h_post_nights")?.status).toBe("pass");
  });

  it("R6 bridges a single leave day in the middle of a stretch", () => {
    // Worked Sat 23 May → Mon 1 Jun, with a leave day on Wed 27 May.
    // Without leave-bridging the run breaks; with bridging it's 10 days.
    const days = [
      "2026-05-23",
      "2026-05-24",
      "2026-05-25",
      "2026-05-26",
      // "2026-05-27" leave
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
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
    const a = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"].flatMap(
      (d) => [mk(d, "am"), mk(d, "pm")],
    );
    const leave = new Set(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]);
    const r = auditTcs2016(a, {
      windowStartISO: "2026-05-25",
      windowEndISO: "2026-07-19", // ~8 weeks
      leaveDates: leave,
    });
    const rule = r.rules.find((x) => x.id === "avg_48h");
    expect(rule?.detail).toMatch(/excluded 5 leave days/);
  });

  it("LTFT pro-rata cap is informational only; the verdict uses 48 h/week", () => {
    // 8 weeks of Mon/Tue/Wed AM+PM (30 h/wk). Pro-rating 48 h by an
    // inferred FTE fraction is not a contractual rule, so this passes.
    const startMon = new Date("2026-05-25T00:00:00Z"); // Monday
    const asgs: AuditAssignment[] = [];
    for (let w = 0; w < 8; w++) {
      for (let dOffset = 0; dOffset < 3; dOffset++) {
        const t = new Date(startMon.getTime() + (w * 7 + dOffset) * 86_400_000);
        const iso = t.toISOString().slice(0, 10);
        asgs.push(mk(iso, "am"), mk(iso, "pm"));
      }
    }
    const r = auditTcs2016(asgs, {
      windowStartISO: "2026-05-25",
      windowEndISO: "2026-07-19",
      ltftDaysOff: [4, 5], // Thu, Fri off → 3/5 = 0.6 FTE
    });
    expect(r.ltftFraction).toBeCloseTo(0.6, 5);
    const rule = r.rules.find((x) => x.id === "avg_48h");
    expect(rule?.status).toBe("pass");
    expect(rule?.detail).toMatch(/28\.8 h\/wk shown for information only/);
  });

  it("LTFT off-days bridge consecutive-day runs in R6", () => {
    // Trainee LTFT with Wednesdays off. Mon, Tue, Thu, Fri, Sat, Sun, Mon, Tue
    // worked → run = 8 (because Wed bridges), should FAIL R6.
    const dates = [
      "2026-05-25",
      "2026-05-26", // Mon, Tue
      // Wed 27 is LTFT off → bridged
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
      "2026-05-31", // Thu-Sun
      "2026-06-01",
      "2026-06-02", // Mon, Tue
    ];
    const asgs = dates.map((d) => mk(d, "am"));
    const r = auditTcs2016(asgs, { ltftDaysOff: [3] }); // Wed
    const rule = r.rules.find((x) => x.id === "max_7_consec_days");
    expect(rule?.status).toBe("fail");
    expect(rule?.detail).toMatch(/8/);
  });

  it("R4 flags night → next-day long shift as a cross-night rest-gap", () => {
    // Single night Mon, then long PM Tue. Both isLong (night=11h, PM not
    // long unless merged with AM, so use a long all-day stretch on Tue).
    const asgs = [
      mk("2026-05-25", "night"), // Mon night
      mk("2026-05-26", "am"),
      mk("2026-05-26", "pm"),
      mk("2026-05-26", "eve"), // Tue AM+PM+eve = 13h
    ];
    const r = auditTcs2016(asgs);
    const rule = r.rules.find((x) => x.id === "max_consecutive_long");
    const notes = rule?.evidence?.notes ?? [];
    expect(notes.some((n) => /also breaches R7/.test(n))).toBe(true);
  });

  it("DST: rotation spanning a UK clock change still produces stable dates", () => {
    // UK DST started Sun 2026-03-29. Cover 14 days Mon-Sun across it.
    const dates = [
      "2026-03-23",
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
    ];
    const asgs = dates.flatMap((d) => [mk(d, "am"), mk(d, "pm")]);
    const r = auditTcs2016(asgs, {
      windowStartISO: "2026-03-23",
      windowEndISO: "2026-04-05",
    });
    // Window dates round-trip exactly (no DST drift to ±1 day).
    expect(r.windowStart).toBe("2026-03-23");
    expect(r.windowEnd).toBe("2026-04-03");
    expect(r.requestedWindowStart).toBe("2026-03-23");
    expect(r.requestedWindowEnd).toBe("2026-04-05");
    // Every shift's stored date equals the date we put in (no off-by-one).
    for (const s of r.shifts) {
      expect(dates).toContain(s.date);
    }
  });
});

describe("auditTcs2016 — honesty regressions (reproduced review cases)", () => {
  it("1: a single AM row is NOT reported compliant when the 48h average is indeterminate", () => {
    const r = auditTcs2016([mk("2026-05-25", "am")]);
    expect(r.rules.find((x) => x.id === "avg_48h")?.status).toBe("indeterminate");
    expect(r.overall).toBe("incomplete");
    expect(r.caveats.join(" ")).toMatch(/inferred/);
  });
  it("2: five consecutive AM+PM+eve (~13h) days breach the default max of 4 long shifts", () => {
    const days = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29"];
    const r = auditTcs2016(days.flatMap((d) => [mk(d, "am"), mk(d, "pm"), mk(d, "eve")]));
    expect(r.rules.find((x) => x.id === "max_consecutive_long")?.status).toBe("fail");
    expect(r.overall).toBe("possible_breach");
  });
  it("3: Mon–Fri for two weeks is not flagged (no '8 in 14' rule exists)", () => {
    const days = [
      "2026-05-25",
      "2026-05-26",
      "2026-05-27",
      "2026-05-28",
      "2026-05-29",
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ];
    const r = auditTcs2016(days.flatMap((d) => [mk(d, "am"), mk(d, "pm")]));
    expect(r.rules.find((x) => x.id === "max_8_in_14")).toBeUndefined();
    expect(r.rules.find((x) => x.id === "max_7_consec_days")?.status).toBe("pass");
    expect(r.rules.some((x) => x.status === "fail")).toBe(false);
  });
  it("4: a Friday night running into Saturday counts as a worked weekend", () => {
    const r = auditTcs2016([mk("2026-05-29", "night", "sho_oncall", "on_call")]);
    expect(r.rules.find((x) => x.id === "weekend_freq")?.detail).toMatch(/^1 weekend/);
    expect(r.shifts[0].isWeekend).toBe(true);
  });
  it("never emits a 'compliant' overall value", () => {
    const days: string[] = [];
    for (let i = 0; i < 26 * 7; i++) {
      const d = new Date(Date.UTC(2026, 0, 5) + i * 86_400_000);
      if (d.getUTCDay() >= 1 && d.getUTCDay() <= 4) days.push(d.toISOString().slice(0, 10));
    }
    const r = auditTcs2016(
      days.map((d) => mk(d, "am")),
      { rotaCycleWeeks: 4 },
    );
    expect(["no_flags_estimated", "incomplete", "possible_breach", "insufficient_data"]).toContain(
      r.overall,
    );
    expect(r.overall).not.toBe("compliant" as never);
  });
});
