/**
 * Pure classifiers used by the CLWRota leave sync. Kept free of Supabase
 * imports so they can be unit-tested in isolation and reused by the
 * `performLeaveSync` upsert path.
 *
 * Why this matters for the professional-leave backfill:
 *   The sync upserts `leave_requests` keyed by `clwrota_external_id`, which
 *   means whatever `type` we compute here will overwrite any prior value.
 *   If we did not classify professional roles (teaching/faculty/instructor/
 *   organising course) as "professional", every overnight CLWRota sync would
 *   silently revert the backfill back to "study". These helpers + their
 *   regression tests pin that behaviour down.
 */

export type LeaveType =
  | "annual"
  | "study"
  | "professional"
  | "compassionate"
  | "sick"
  | "parental"
  | "other";

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

/**
 * Keywords in the free-text reason that indicate the person is acting in a
 * professional role (delivering training, examining, organising) rather than
 * receiving personal training. Mirrors the SQL backfill rules.
 *
 * Notes on negative-lookahead:
 *  - "instructor course" is a course you ATTEND to become an instructor →
 *    that is study leave, not professional. The regex below allows the
 *    word "instructor" but only when it is not directly followed by
 *    " course".
 */
const PROFESSIONAL_REASON_RE =
  /\b(faculty|instructing|teaching|teach\b|examiner|examining|organising|organizing|coach to lead|lead(ing)? (the )?course|appraisal|college work|committee|chairing|chair the)\b/i;
const INSTRUCTOR_NOT_ATTENDING_RE = /\binstructor\b(?!\s+course)/i;

/** True if the free-text reason indicates a professional (not learner) role. */
export function looksLikeProfessionalReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  if (PROFESSIONAL_REASON_RE.test(reason)) return true;
  if (INSTRUCTOR_NOT_ATTENDING_RE.test(reason)) return true;
  return false;
}

/**
 * Classify a CLWRota leave row into a local `leave_type` enum value.
 *
 * The CLWRota feed only carries a coarse `type` (e.g. "Study Leave",
 * "Annual Leave"). Professional leave is distinguished from study leave by
 * inspecting the request's free-text reason — same logic as the historical
 * backfill.
 */
export function classifyLeaveType(
  typeRaw: string | null | undefined,
  reasonRaw: string | null | undefined = null,
): LeaveType {
  const s = (typeRaw ?? "").toLowerCase();

  // Explicit upstream "professional" label (rare) wins outright.
  if (s.includes("professional")) return "professional";

  if (s.includes("annual") || s.includes("holiday") || s === "al" || s.includes("vacation"))
    return "annual";

  if (s.includes("study") || s.includes("conference") || s.includes("course") || s === "sl") {
    // A "Study Leave" row whose reason describes a teaching/faculty role
    // is reclassified to "professional" so balances stay correct after the
    // historical backfill.
    if (looksLikeProfessionalReason(reasonRaw)) return "professional";
    return "study";
  }

  if (s.includes("compassion") || s.includes("bereave")) return "compassionate";
  if (s.includes("sick") || s.includes("illness")) return "sick";
  if (s.includes("matern") || s.includes("patern") || s.includes("parental") || s.includes("adopt"))
    return "parental";

  if (!s) return "other";
  return "other";
}

/**
 * Fallback value used when a CLWRota status string cannot be parsed.
 *
 * Policy: "approved".
 * Rationale: CLWRota only publishes already-approved leave on its feed, so
 * an unrecognised or blank status is treated as approved rather than silently
 * swallowed or marked pending.  Making this a named constant keeps the
 * fallback visible and auditable.
 */
export const DEFAULT_LEAVE_STATUS: LeaveStatus = "approved";

/**
 * Normalize a raw CLWRota status string into our four canonical states.
 *
 * Behaviour:
 *  - Trims, lower-cases, collapses internal whitespace and strips surrounding
 *    punctuation so "  Approved.  " and "APPROVED" both match.
 *  - Recognises an extended synonym set for each state (e.g. "auth(orised)",
 *    "ok", "signed off" → approved; "refused", "not approved", "turned down"
 *    → rejected; "void", "revoked", "rescinded" → cancelled; "in review",
 *    "tbc", "on hold", "with hr" → pending).
 *  - Also recognises a targeted set of non-English status words seen on UK
 *    NHS rota imports where admins paste from third-party HR tooling
 *    (French, German, Spanish, Italian, Polish, Welsh). The list is
 *    deliberately small — extend it via regression tests, not silently.
 *  - "not approved" / "not granted" / "not permitted" are matched BEFORE the
 *    approved synonyms so the negation wins.
 *  - Multi-word UK-admin phrases ("turned down", "on hold", "with hr",
 *    "called off", "for review", "awaiting authorisation") are matched
 *    before the single-word regexes so the phrase wins over an incidental
 *    keyword inside it.
 *  - Empty / unknown input falls back to {@link DEFAULT_LEAVE_STATUS}
 *    (currently "approved") because CLWRota only publishes already-approved
 *    leave on its feed.
 */
export function classifyLeaveStatus(raw: string | null | undefined): LeaveStatus {
  const s = (raw ?? "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ") // strip punctuation/symbols
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return DEFAULT_LEAVE_STATUS;

  // Negations must beat the plain "approved/granted/permitted" match below.
  if (
    /\bnot\s+(approved|granted|authorised|authorized|accepted|permitted|allowed|sanctioned|agreed)\b/.test(
      s,
    )
  )
    return "rejected";

  // Multi-word UK-admin phrases — checked before single-word regexes so a
  // phrase like "turned down" is not partially matched as "down".
  if (/\b(turned down|knocked back|sent back|not going ahead)\b/.test(s)) return "rejected";
  if (/\b(called off|pulled from rota|rolled back)\b/.test(s)) return "cancelled";
  if (
    /\b(on hold|for review|under consideration|awaiting (approval|authorisation|authorization|sign[- ]?off|decision)|with (hr|manager|line manager|rota|admin)|to be confirmed|to be decided|in the queue)\b/.test(
      s,
    )
  )
    return "pending";

  if (
    /\b(approved?|approve|granted?|grant|authoris(ed|e)|authoriz(ed|e)|accepted?|confirmed?|confirm|signed off|sign off|sanctioned?|endorsed?|ratified?|cleared?|permitted?|allowed?|agreed?|passed?|ok|okay|yes|y)\b/.test(
      s,
    ) ||
    // Non-English approved synonyms (French, German, Spanish, Italian,
    // Polish, Welsh) — common on UK NHS rota imports.
    /\b(approuv[ée]e?|accept[ée]e?|valid[ée]e?|genehmigt|bewilligt|zugestimmt|aprobad[oa]|aprovad[oa]|aceptad[oa]|approvat[oa]|accettat[oa]|zatwierdzon[ya]|zaakceptowan[ya]|cymeradwyo|cymeradwywyd|derbyniwyd)\b/.test(
      s,
    )
  )
    return "approved";

  if (
    /\b(rejected?|reject|denied?|deny|declined?|decline|refused?|refuse|disallowed?|vetoed?|blocked?|dismissed?|no)\b/.test(
      s,
    ) ||
    /\b(refus[ée]e?|rejet[ée]e?|abgelehnt|verweigert|rechazad[oa]|denegad[oa]|rifiutat[oa]|respint[oa]|odrzucon[ya]|odmowa|gwrthod|gwrthodwyd)\b/.test(
      s,
    )
  )
    return "rejected";

  if (
    /\b(cancelled?|canceled?|cancel|withdrawn|withdraw|void(ed)?|revoked?|revoke|removed?|deleted?|rescinded?|scrapped?|abandoned?)\b/.test(
      s,
    ) ||
    /\b(annul[ée]e?|annull?at[oa]|storniert|abgesagt|cancelad[oa]|anulad[oa]|annullat[oa]|anulowan[ya]|wycofan[ya]|diddymwyd)\b/.test(
      s,
    )
  )
    return "cancelled";

  if (
    /\b(pending|request(ed)?|await(ing)?|submitted?|submit|review(ing)?|in review|tbc|tbd|unconfirmed|open|outstanding|queued)\b/.test(
      s,
    ) ||
    /\b(en attente|en cours|ausstehend|in bearbeitung|pendiente|en espera|en revisi[óo]n|in attesa|in sospeso|oczekuj[ąa]c[ye]?|w trakcie|aros|yn aros)\b/.test(
      s,
    )
  )
    return "pending";

  // Explicit fallback for strings that survive normalisation but match
  // no known synonym.  See DEFAULT_LEAVE_STATUS for the policy rationale.
  return DEFAULT_LEAVE_STATUS;
}
