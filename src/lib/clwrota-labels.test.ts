import { describe, expect, it } from "vitest";
import { isNonWorkingRotaLabel, legacyIsNonWorkingRotaLabel } from "./clwrota-labels";
import { classifyDutyType, type DutyTypeMappingRow } from "@/features/clwrota/parsing";

// Row shape mirrors the import: [slot title, role, specialty, place, notes].
const row = (
  slot: string | null,
  role: string | null,
  specialty: string | null,
  place: string | null,
  notes: string | null = null,
) => [slot, role, specialty, place, notes];

describe("isNonWorkingRotaLabel — off-site locations are working rows", () => {
  it("keeps the Laser AM pattern (place Laser, specialty 'Off site')", () => {
    expect(isNonWorkingRotaLabel(row("Laser", "Theatre", "Off site", "Laser"))).toBe(false);
    expect(legacyIsNonWorkingRotaLabel(row("Laser", "Theatre", "Off site", "Laser"))).toBe(true);
  });

  it("neutralises every spelling of the off-site phrase", () => {
    for (const v of ["Off site", "Off-site", "Off/Site", "OFF SITE", "off_site", "Off  site", "Off sites", "Laser / Off site", "Off-Site: Laser"]) {
      expect(isNonWorkingRotaLabel([v]), v).toBe(false);
    }
  });

  it("still drops genuine day-off markers with no off-site wording", () => {
    for (const v of ["Off", "Off Day", "Day off", "Surgeon: Off", "Regular day off", "LTFT day off", "Not working", "Available", "Spare", "TBC", "Unallocated", "Nil"]) {
      expect(isNonWorkingRotaLabel([v]), v).toBe(true);
    }
  });

  it("still drops an off-site row whose same string also says off / day off / available", () => {
    for (const v of ["Off site - day off", "Off site (off)", "Off-site / Off", "Off site available", "Off site, not working", "Day off - off site"]) {
      expect(isNonWorkingRotaLabel([v]), v).toBe(true);
    }
  });

  it("still drops an off-site row when another field independently says off / leave / rest", () => {
    expect(isNonWorkingRotaLabel(row("Day off", null, "Off site", "Laser"))).toBe(true);
    expect(isNonWorkingRotaLabel(row("Laser", null, "Off site", "Laser", "Available"))).toBe(true);
    expect(isNonWorkingRotaLabel(row("Annual leave", null, "Off site", "Laser"))).toBe(true);
    expect(isNonWorkingRotaLabel(row("Laser", "Study leave", "Off site", "Laser"))).toBe(true);
    expect(isNonWorkingRotaLabel(row("Laser", null, "Off site", "Laser", "Rest day"))).toBe(true);
    expect(isNonWorkingRotaLabel(row("Laser", null, "Off-site", "Laser", "Sick"))).toBe(true);
  });

  it("still drops off-site rows that are leave / rest / absence in the same string", () => {
    for (const v of ["Off site annual leave", "Off-site study leave", "Off site - sick", "Off site rest", "Off site post nights rest", "Off site TOIL", "Off site lieu day", "Off site maternity", "Off site parental leave", "Off site bank holiday", "Off site absent"]) {
      expect(isNonWorkingRotaLabel([v]), v).toBe(true);
    }
  });

  it("does not change rows without off-site wording (leave wording alone is not a new drop rule)", () => {
    for (const v of ["Annual leave", "Study leave", "Rest day", "Laser", "Theatre 3", "SPA", "Tutorial / SPA"]) {
      expect(isNonWorkingRotaLabel([v]), v).toBe(legacyIsNonWorkingRotaLabel([v]));
    }
  });

  it("does not drop real off-site lists whose titles contain look-alike words", () => {
    expect(isNonWorkingRotaLabel(row("Mr Al-Hassan", null, "Off site", "Laser"))).toBe(false);
    expect(isNonWorkingRotaLabel(row("Restorative dentistry", null, "Off site", "NHH"))).toBe(false);
    expect(isNonWorkingRotaLabel(row("Free flap", null, "Off site", "NHH"))).toBe(false);
    expect(isNonWorkingRotaLabel(row("Offsite MRI", null, null, "MRI"))).toBe(false);
  });

  it("keeps coordinator-configured extra tokens working", () => {
    expect(isNonWorkingRotaLabel(["Off site study leave"], ["study leave"])).toBe(true);
    expect(isNonWorkingRotaLabel(["Off site teaching"], ["teaching"])).toBe(true);
  });

  it("only ever un-drops rows that mention off site and carry no off/leave/rest marker", () => {
    const fields = [null, "Off site", "Off-site", "Laser", "Annual leave", "Day off", "Off", "Rest day", "SPA", "Tutorial", "Admin", "Available", "Theatre 3"];
    for (const a of fields)
      for (const b of fields)
        for (const c of fields) {
          const labels = [a, b, c];
          const before = legacyIsNonWorkingRotaLabel(labels);
          const after = isNonWorkingRotaLabel(labels);
          if (before === after) continue;
          // Never newly drops a row.
          expect(before, JSON.stringify(labels)).toBe(true);
          // Newly kept rows must mention off site and contain no genuine marker.
          const joined = labels.filter(Boolean).join(" | ").toLowerCase();
          expect(joined).toMatch(/off.?site/);
          expect(joined).not.toMatch(/leave|rest|day off|available|(^|\| )off($| \|)/);
        }
  });
});

describe("off-site teaching / admin rows stay non-spare after the fix", () => {
  // Subset of the configured duty mappings (word/substring, by priority).
  const m = (duty_type: DutyTypeMappingRow["duty_type"], pattern: string, match_type: DutyTypeMappingRow["match_type"], priority: number): DutyTypeMappingRow => ({
    duty_type, pattern, match_type, priority, grade_filter: null, trainee_seniority_filter: null, active: true,
  });
  const mappings = [
    m("spa", "spa", "word", 10),
    m("teaching", "teach", "substring", 20),
    m("admin", "admin", "substring", 30),
    m("teaching", "tutorial", "substring", 50),
    m("non_clinical", "study", "substring", 92),
  ];

  it("imports them (they are working rows) and classifies them as teaching/admin/SPA, not theatre", () => {
    const cases: Array<[Array<string | null>, string]> = [
      [row("Teaching", "Admin", "Off site", null), "teaching"],
      [row("Admin", "Admin", "Off site", null), "admin"],
      [row("SPA", null, "Off-site", null), "spa"],
      [row("Tutorial", null, "Off site", null), "teaching"],
      [row("Study day", null, "Off site", null), "non_clinical"],
    ];
    for (const [labels, duty] of cases) {
      expect(isNonWorkingRotaLabel(labels), JSON.stringify(labels)).toBe(false);
      expect(classifyDutyType(labels, "consultant", null, mappings)).toBe(duty);
    }
  });
});
