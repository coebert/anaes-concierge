export interface GlossaryEntry {
  term: string;
  acronym: string;
  definition: string;
  category: "clinical" | "administrative" | "rota" | "theatre";
  related?: string[];
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: "Supporting Professional Activity",
    acronym: "SPA",
    category: "administrative",
    definition:
      "Non-clinical consultant time dedicated to activities such as teaching, audit, research, appraisal, and departmental management. In a consultant job plan, total Programmed Activities (PAs) are split into Direct Clinical Care (DCC) PAs and SPA PAs.",
    related: ["DCC", "PA"],
  },
  {
    term: "New Hall Hospital",
    acronym: "NHH",
    category: "theatre",
    definition:
      "The local private hospital where the department also provides anaesthetic cover. It has 5 theatres (NHH Theatre 1–5). Do not confuse this with the on-call duty type 'nhh_oncall' ("Night Hospital" out-of-hours cover).",
    related: ["CoD"],
  },
  {
    term: "Direct Clinical Care",
    acronym: "DCC",
    category: "administrative",
    definition:
      "The clinical portion of a consultant job plan — time spent on direct patient care in theatres, clinics, and wards. Total PAs = DCC PAs + SPA PAs.",
    related: ["SPA", "PA"],
  },
  {
    term: "Programmed Activity",
    acronym: "PA",
    category: "administrative",
    definition:
      "A standard 4-hour block used to measure contracted time in NHS consultant and SAS contracts. A typical full-time job plan contains 10–11 PAs per week (8 DCC + 2–3 SPA).",
    related: ["DCC", "SPA", "LTFT"],
  },
  {
    term: "Less Than Full Time",
    acronym: "LTFT",
    category: "administrative",
    definition:
      "A reduced working-hours arrangement. Trainees and consultants working LTFT have their job-plan PAs and on-call commitments scaled pro-rata. For example, 80% LTFT = 8 PAs instead of 10.",
    related: ["PA"],
  },
  {
    term: "Pre-Operative Assessment Unit",
    acronym: "POAU",
    category: "clinical",
    definition:
      "A dedicated unit where patients are assessed before surgery to optimise fitness and plan anaesthetic management. Lists here are non-theatre clinical sessions.",
    related: ["DSU"],
  },
  {
    term: "Day Surgery Unit",
    acronym: "DSU",
    category: "theatre",
    definition:
      "The three day-surgery theatres at Salisbury DGH: Day Surgery A, B, and F. These handle short-stay procedures separate from the 10 main NHS theatres.",
    related: ["POAU"],
  },
  {
    term: "Consultant of the Day",
    acronym: "CoD",
    category: "rota",
    definition:
      "The senior consultant responsible for overall coordination of anaesthetic services during the day shift. On the rota this maps to the duty type 'consultant_in_charge'.",
    related: ["NHH"],
  },
  {
    term: "Solo list",
    acronym: "",
    category: "rota",
    definition:
      "A theatre list where a trainee anaesthetist works without direct consultant supervision in the room. Solo lists are tracked for training progression and must meet safety criteria (senior cover available, appropriate case mix, etc.). The system auto-detects and flags suspicious solo lists.",
    related: ["LTFT"],
  },
];

/** All acronym variants that should trigger a tooltip, mapped to the entry index. */
export const ACRONYM_MAP: Record<string, number> = {
  spa: 0,
  "supporting professional activity": 0,
  nhh: 1,
  "new hall hospital": 1,
  dcc: 2,
  "direct clinical care": 2,
  pa: 3,
  "programmed activity": 3,
  ltft: 4,
  "less than full time": 4,
  poau: 5,
  "pre-operative assessment unit": 5,
  dsu: 6,
  "day surgery unit": 6,
  cod: 7,
  "consultant of the day": 7,
  "consultant of the": 7,
  "solo list": 8,
  "solo lists": 8,
};

/** Look up a glossary entry by acronym (case-insensitive). */
export function lookupGlossary(key: string): GlossaryEntry | undefined {
  const k = key.trim().toLowerCase();
  const idx = ACRONYM_MAP[k];
  if (idx !== undefined) return GLOSSARY[idx];
  // Fallback: try partial match on acronym field
  return GLOSSARY.find((g) => g.acronym.toLowerCase() === k);
}
