/**
 * Theatre Pressure Forecast (v1) — read-only.
 *
 * Highlights days where explicitly labelled VRAM, DIEP or robotic lists
 * may add *potential* pressure, alongside the existing Robustness AM/PM
 * staffing headroom. It is a signal for coordinators, NOT a prediction of
 * overruns, and it never infers a procedure from who the surgeon is, from
 * the theatre (room) name or from a broad specialty.
 *
 * Where the labels come from (verified against the CLWRota import):
 *  - `theatre_sessions.surgical_consultant` — the imported list/slot title
 *    (CLWRota `slot_titles`). Only explicit tokens in that text are used.
 *  - `theatre_sessions.notes` — NOT written by the import; only a
 *    coordinator-entered list note from the theatre grid / cell dialog.
 *  - linked `rota_assignments.notes` — the import keeps only the FIRST
 *    non-empty free-text field (often the place name), so later fields on
 *    the same CLWRota row are not stored and cannot be scanned.
 *  - There are no structured procedure-tag columns in the data model.
 *
 * Privacy: raw label text and database identifiers never leave the
 * extraction step. Evidence carries tags, source kinds and a one-way
 * title fingerprint (equality only) so the cached/rendered forecast holds
 * no free text, staff or record IDs.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRowsPaged, idKey } from "./paginate";
import type { HalfDayCapacity } from "./robustness";

export type ProcedureTag = "VRAM" | "DIEP" | "Robotic";
export const PROCEDURE_TAGS: readonly ProcedureTag[] = ["VRAM", "DIEP", "Robotic"];

/** Only the first N characters of any single label are scanned. */
export const TAG_SCAN_MAX_CHARS = 500;

// Bounded on both sides by a non-alphanumeric character (or string edge),
// so "DIEP flap" / "(VRAM)" / "Robot-assisted" match but "diepoxide",
// "vrams", "irobot" and "robotically" do not.
const TAG_RE = /(?<![a-z0-9])(vram|diep|robotics|robotic|robot)(?![a-z0-9])/gi;

export function detectProcedureTags(text: string | null | undefined): ProcedureTag[] {
  if (!text) return [];
  const scanned = text.slice(0, TAG_SCAN_MAX_CHARS);
  const out = new Set<ProcedureTag>();
  for (const m of scanned.matchAll(TAG_RE)) {
    const t = (m[1] ?? "").toLowerCase();
    if (t === "vram") out.add("VRAM");
    else if (t === "diep") out.add("DIEP");
    else out.add("Robotic");
  }
  return PROCEDURE_TAGS.filter((t) => out.has(t));
}

export type TagSource = "imported_list_title" | "coordinator_list_note" | "assignment_note";

export const TAG_SOURCE_LABEL: Record<TagSource, string> = {
  imported_list_title: "imported list title",
  coordinator_list_note: "coordinator list note",
  assignment_note: "linked assignment note",
};

export type ForecastHalf = "am" | "pm" | "eve" | "night";

/** One theatre session, already stripped of raw text and identifiers. */
export interface ListEvidence {
  date: string;
  half: ForecastHalf;
  /** Opaque per-load ordinal grouping sessions in the same theatre. */
  theatreRef: number;
  theatreName: string;
  tags: ProcedureTag[];
  sources: TagSource[];
  /** One-way fingerprint of the normalised imported title; null when absent. */
  titleFingerprint: string | null;
  /** No imported title and no coordinator note — tag status unknown. */
  missingTitle: boolean;
  /** Some label exceeded TAG_SCAN_MAX_CHARS and was only partly scanned. */
  scanTruncated: boolean;
}

export interface EvidenceSet {
  lists: ListEvidence[];
  excludedInactiveTagged: number;
  missingTheatre: number;
}

export interface RawSession {
  id: string;
  session_date: string;
  session: string;
  theatre_id: string | null;
  surgical_consultant: string | null;
  notes: string | null;
}
export interface RawTheatre {
  id: string;
  name: string;
  active: boolean;
}
export interface RawAssignment {
  theatre_session_id: string | null;
  notes: string | null;
}

function normaliseTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** cyrb53 — fast 53-bit string hash; used only for equality of titles. */
function fingerprint(str: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const nonEmpty = (s: string | null | undefined): s is string => !!s && s.trim().length > 0;

/**
 * Pure: turn raw rows into privacy-safe evidence. Theatre (room) names and
 * specialties are deliberately NOT scanned for tags.
 */
export function extractListEvidence(
  sessions: RawSession[],
  theatres: RawTheatre[],
  assignments: RawAssignment[],
): EvidenceSet {
  const theatreById = new Map(theatres.map((t) => [t.id, t]));
  const theatreOrdinal = new Map<string, number>();
  const notesBySession = new Map<string, string[]>();
  for (const a of assignments) {
    if (!a.theatre_session_id || !nonEmpty(a.notes)) continue;
    const arr = notesBySession.get(a.theatre_session_id) ?? [];
    arr.push(a.notes);
    notesBySession.set(a.theatre_session_id, arr);
  }

  const lists: ListEvidence[] = [];
  let excludedInactiveTagged = 0;
  let missingTheatre = 0;

  for (const s of sessions) {
    const sourceTags = new Map<TagSource, ProcedureTag[]>();
    let truncated = false;
    const scan = (src: TagSource, text: string | null) => {
      if (!nonEmpty(text)) return;
      if (text.length > TAG_SCAN_MAX_CHARS) truncated = true;
      const found = detectProcedureTags(text);
      if (found.length) sourceTags.set(src, [...(sourceTags.get(src) ?? []), ...found]);
    };
    scan("imported_list_title", s.surgical_consultant);
    scan("coordinator_list_note", s.notes);
    // Repeated linked assignments (several anaesthetists, duplicate rows)
    // collapse into the one session: tags are unioned below.
    for (const n of notesBySession.get(s.id) ?? []) scan("assignment_note", n);

    const tagSet = new Set<ProcedureTag>();
    for (const ts of sourceTags.values()) for (const t of ts) tagSet.add(t);
    const tags = PROCEDURE_TAGS.filter((t) => tagSet.has(t));

    const theatre = s.theatre_id ? theatreById.get(s.theatre_id) : undefined;
    if (theatre && !theatre.active) {
      // Stale rows on inactive theatres are dropped (same rule as Robustness).
      if (tags.length) excludedInactiveTagged++;
      continue;
    }
    if (!theatre) missingTheatre++;
    const ordKey = theatre?.id ?? `missing:${s.theatre_id ?? "none"}`;
    if (!theatreOrdinal.has(ordKey)) theatreOrdinal.set(ordKey, theatreOrdinal.size);

    const title = nonEmpty(s.surgical_consultant) ? normaliseTitle(s.surgical_consultant) : "";
    lists.push({
      date: s.session_date,
      half: (["am", "pm", "eve", "night"].includes(s.session) ? s.session : "am") as ForecastHalf,
      theatreRef: theatreOrdinal.get(ordKey)!,
      theatreName: theatre?.name ?? "Unknown theatre",
      tags,
      sources: (Object.keys(TAG_SOURCE_LABEL) as TagSource[]).filter((k) => sourceTags.has(k)),
      titleFingerprint: title ? fingerprint(title) : null,
      missingTitle: !nonEmpty(s.surgical_consultant) && !nonEmpty(s.notes),
      scanTruncated: truncated,
    });
  }
  return { lists, excludedInactiveTagged, missingTheatre };
}

// ───────────────────────────── Forecast ─────────────────────────────

export type HalfRisk = HalfDayCapacity["risk"];
export type StaffingStatus = HalfRisk | "not_assessed";

export interface StaffingDayInput {
  date: string;
  am: { risk: HalfRisk };
  pm: { risk: HalfRisk };
}

export type ListIdentity =
  /** One session row in one half. */
  | "single_half"
  /** AM + PM rows in the same theatre with the same imported title. */
  | "all_day_same_title"
  /** AM/PM rows in the same theatre that MAY be one list — not confirmed. */
  | "possibly_same_as_other_half";

export interface TaggedList {
  key: string;
  date: string;
  theatreName: string;
  halves: ForecastHalf[];
  identity: ListIdentity;
  tags: ProcedureTag[];
  sources: TagSource[];
  staffing: Array<{ half: ForecastHalf; status: StaffingStatus }>;
}

export type PressureReasonCode =
  | "multiple_tagged_lists"
  | "possible_multiple_tagged_lists"
  | "multiple_lists_constrained_cover"
  | "tagged_list_constrained_cover"
  | "staffing_not_verified"
  | "untitled_lists_same_day";

export interface PressureReason {
  code: PressureReasonCode;
  text: string;
}

export type PressureLevel = "elevated" | "potential" | "unverified" | "noted";

export interface PressureDay {
  date: string;
  level: PressureLevel;
  lists: TaggedList[];
  /** Distinct tagged lists counting unresolved AM/PM pairs once. */
  distinctMin: number;
  /** Distinct tagged lists counting unresolved AM/PM pairs twice. */
  distinctMax: number;
  reasons: PressureReason[];
  untitledLists: number;
}

export interface TheatrePressureForecast {
  rangeStart: string;
  rangeEnd: string;
  days: PressureDay[];
  totals: {
    taggedDays: number;
    elevatedDays: number;
    potentialDays: number;
    unverifiedDays: number;
    distinctListsMin: number;
    distinctListsMax: number;
    unresolvedPairs: number;
    listsInWindow: number;
    untitledLists: number;
    truncatedScans: number;
    weekdaysWithoutLists: number;
    excludedInactiveTagged: number;
    missingTheatre: number;
  };
  staffingAvailable: boolean;
}

const CONSTRAINED: ReadonlySet<StaffingStatus> = new Set(["tight", "spa_required", "shortfall"]);

const HALF_LABEL: Record<ForecastHalf, string> = {
  am: "AM",
  pm: "PM",
  eve: "Evening",
  night: "Night",
};
export const halfLabel = (h: ForecastHalf) => HALF_LABEL[h];

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const isWeekday = (iso: string) => {
  const dow = new Date(iso + "T00:00:00Z").getUTCDay();
  return dow >= 1 && dow <= 5;
};

const HALF_ORDER: Record<ForecastHalf, number> = { am: 0, pm: 1, eve: 2, night: 3 };

/**
 * Pure forecast builder. `staffing` is the Robustness day list for the same
 * window, or `null` when it is unavailable (loading/failed) — then every
 * tagged half is reported as "not assessed", never as OK.
 */
export function buildTheatrePressureForecast(input: {
  rangeStart: string;
  rangeEnd: string;
  evidence: EvidenceSet;
  staffing: StaffingDayInput[] | null;
}): TheatrePressureForecast {
  const { rangeStart, rangeEnd, evidence, staffing } = input;
  const staffByDate = new Map((staffing ?? []).map((d) => [d.date, d]));
  const statusFor = (date: string, half: ForecastHalf): StaffingStatus => {
    if (half !== "am" && half !== "pm") return "not_assessed";
    const d = staffByDate.get(date);
    return d ? d[half].risk : "not_assessed";
  };

  const inRange = evidence.lists.filter((l) => l.date >= rangeStart && l.date <= rangeEnd);
  const byDate = new Map<string, ListEvidence[]>();
  for (const l of inRange) {
    const arr = byDate.get(l.date) ?? [];
    arr.push(l);
    byDate.set(l.date, arr);
  }

  const days: PressureDay[] = [];
  let unresolvedPairs = 0;
  for (const [date, lists] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const untitledLists = lists.filter((l) => l.missingTitle && l.tags.length === 0).length;
    const tagged = lists
      .filter((l) => l.tags.length > 0)
      .sort(
        (a, b) =>
          a.theatreName.localeCompare(b.theatreName) ||
          a.theatreRef - b.theatreRef ||
          HALF_ORDER[a.half] - HALF_ORDER[b.half],
      );
    if (tagged.length === 0) continue;

    const out: TaggedList[] = [];
    let distinctMin = 0;
    let distinctMax = 0;
    const used = new Set<ListEvidence>();
    for (const l of tagged) {
      if (used.has(l)) continue;
      used.add(l);
      const partner =
        l.half === "am"
          ? tagged.find((o) => !used.has(o) && o.half === "pm" && o.theatreRef === l.theatreRef)
          : undefined;
      const mk = (
        halves: ForecastHalf[],
        identity: ListIdentity,
        tags: ProcedureTag[],
        sources: TagSource[],
      ): TaggedList => ({
        key: `${date}-${out.length}`,
        date,
        theatreName: l.theatreName,
        halves,
        identity,
        tags,
        sources,
        staffing: halves.map((h) => ({ half: h, status: statusFor(date, h) })),
      });
      if (!partner) {
        out.push(mk([l.half], "single_half", l.tags, l.sources));
        distinctMin++;
        distinctMax++;
        continue;
      }
      used.add(partner);
      const sameTitle =
        l.titleFingerprint !== null && l.titleFingerprint === partner.titleFingerprint;
      const sharedTag = l.tags.some((t) => partner.tags.includes(t));
      const bothTitled = l.titleFingerprint !== null && partner.titleFingerprint !== null;
      if (sameTitle) {
        const tags = PROCEDURE_TAGS.filter((t) => l.tags.includes(t) || partner.tags.includes(t));
        const sources = (Object.keys(TAG_SOURCE_LABEL) as TagSource[]).filter(
          (s) => l.sources.includes(s) || partner.sources.includes(s),
        );
        out.push(mk(["am", "pm"], "all_day_same_title", tags, sources));
        distinctMin++;
        distinctMax++;
      } else if (bothTitled && !sharedTag) {
        // Different titles AND different procedures: two separate lists.
        out.push(mk(["am"], "single_half", l.tags, l.sources));
        out.push({
          ...mk(["pm"], "single_half", partner.tags, partner.sources),
          key: `${date}-${out.length}`,
        });
        distinctMin += 2;
        distinctMax += 2;
      } else {
        // Same theatre, both halves tagged, but identity unproven.
        unresolvedPairs++;
        out.push(mk(["am"], "possibly_same_as_other_half", l.tags, l.sources));
        out.push({
          ...mk(["pm"], "possibly_same_as_other_half", partner.tags, partner.sources),
          key: `${date}-${out.length}`,
        });
        distinctMin += 1;
        distinctMax += 2;
      }
    }

    const relevant = new Map<ForecastHalf, StaffingStatus>();
    for (const l of out) for (const s of l.staffing) relevant.set(s.half, s.status);
    const constrainedHalves = [...relevant.entries()].filter(([, s]) => CONSTRAINED.has(s));
    const unassessedHalves = [...relevant.entries()].filter(([, s]) => s === "not_assessed");
    const fmtHalves = (hs: Array<[ForecastHalf, StaffingStatus]>) =>
      hs.map(([h]) => HALF_LABEL[h]).join(" + ");

    const reasons: PressureReason[] = [];
    const multi = distinctMin >= 2;
    const possibleMulti = !multi && distinctMax >= 2;
    if (multi) {
      reasons.push({
        code: "multiple_tagged_lists",
        text: `${distinctMin} distinct tagged lists on the same day.`,
      });
    } else if (possibleMulti) {
      reasons.push({
        code: "possible_multiple_tagged_lists",
        text: "Possibly 2 tagged lists — the AM and PM entries could be one all-day list; not confirmed.",
      });
    }
    if (constrainedHalves.length) {
      if (multi) {
        reasons.push({
          code: "multiple_lists_constrained_cover",
          text: `Cover is tight, SPA-dependent or short in ${fmtHalves(constrainedHalves)} while multiple tagged lists run.`,
        });
      } else {
        reasons.push({
          code: "tagged_list_constrained_cover",
          text: `Tagged list with tight, SPA-dependent or short cover in ${fmtHalves(constrainedHalves)}.`,
        });
      }
    }
    if (unassessedHalves.length) {
      reasons.push({
        code: "staffing_not_verified",
        text: `Staffing not verified for ${fmtHalves(unassessedHalves)} — treat as unknown, not as OK.`,
      });
    }
    if (untitledLists > 0) {
      reasons.push({
        code: "untitled_lists_same_day",
        text: `${untitledLists} other list(s) this day have no title or note, so their tag status is unknown.`,
      });
    }

    const level: PressureLevel =
      multi && constrainedHalves.length
        ? "elevated"
        : multi || possibleMulti || constrainedHalves.length
          ? "potential"
          : unassessedHalves.length
            ? "unverified"
            : "noted";

    days.push({ date, level, lists: out, distinctMin, distinctMax, reasons, untitledLists });
  }

  const datesWithLists = new Set(inRange.map((l) => l.date));
  const weekdaysWithoutLists = eachDate(rangeStart, rangeEnd).filter(
    (d) => isWeekday(d) && !datesWithLists.has(d),
  ).length;

  return {
    rangeStart,
    rangeEnd,
    days,
    staffingAvailable: staffing !== null,
    totals: {
      taggedDays: days.length,
      elevatedDays: days.filter((d) => d.level === "elevated").length,
      potentialDays: days.filter((d) => d.level === "potential").length,
      unverifiedDays: days.filter((d) => d.reasons.some((r) => r.code === "staffing_not_verified"))
        .length,
      distinctListsMin: days.reduce((s, d) => s + d.distinctMin, 0),
      distinctListsMax: days.reduce((s, d) => s + d.distinctMax, 0),
      unresolvedPairs,
      listsInWindow: inRange.length,
      untitledLists: inRange.filter((l) => l.missingTitle && l.tags.length === 0).length,
      truncatedScans: inRange.filter((l) => l.scanTruncated).length,
      weekdaysWithoutLists,
      excludedInactiveTagged: evidence.excludedInactiveTagged,
      missingTheatre: evidence.missingTheatre,
    },
  };
}

// ───────────────────────────── Loader ─────────────────────────────

type Client = Pick<typeof supabase, "from">;

/**
 * Loads the window's theatre sessions, theatres and linked assignment
 * notes through the shared paged helper (stable id order; truncation or a
 * failed page throws) and returns privacy-safe evidence only. RLS applies
 * as the signed-in user — the same access as the rest of Robustness.
 */
export async function loadTheatrePressureEvidence(
  rangeStart: string,
  rangeEnd: string,
  client: Client = supabase,
): Promise<EvidenceSet> {
  const [sessions, theatres, assignments] = await Promise.all([
    fetchAllRowsPaged<RawSession>(
      (from, to) =>
        client
          .from("theatre_sessions")
          .select("id, session_date, session, theatre_id, surgical_consultant, notes")
          .gte("session_date", rangeStart)
          .lte("session_date", rangeEnd)
          .order("id", { ascending: true })
          .range(from, to),
      { rowKey: idKey, label: "theatre-pressure.theatre_sessions" },
    ),
    fetchAllRowsPaged<RawTheatre>(
      (from, to) =>
        client
          .from("theatres")
          .select("id, name, active")
          .order("id", { ascending: true })
          .range(from, to),
      { rowKey: idKey, label: "theatre-pressure.theatres" },
    ),
    fetchAllRowsPaged<RawAssignment & { id: string }>(
      (from, to) =>
        client
          .from("rota_assignments")
          .select("id, theatre_session_id, notes")
          .gte("session_date", rangeStart)
          .lte("session_date", rangeEnd)
          .not("theatre_session_id", "is", null)
          .order("id", { ascending: true })
          .range(from, to),
      { rowKey: idKey, label: "theatre-pressure.rota_assignments" },
    ),
  ]);
  return extractListEvidence(sessions, theatres, assignments);
}
