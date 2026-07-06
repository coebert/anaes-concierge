/**
 * Zod schemas for CLWRota (Rotamap Central API) responses.
 *
 * These schemas describe the shape of upstream payloads. They are intentionally
 * permissive (`.passthrough()`, most fields optional) because CLWRota's field
 * names vary across tenants and report configurations — downstream code uses
 * `pick()` (see parsing.ts) with alias arrays to tolerate legacy naming.
 *
 * Kept in a dedicated module so both the parsing layer and any future
 * response validators can share a single source of truth.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Top-level response wrappers
// ---------------------------------------------------------------------------

/**
 * Rotamap's "central_api" tabular response:
 *   { columns: [{ field_name, ui_name, ... }, ...], rows: [[v1, v2, ...], ...] }
 * Rows may also arrive as objects rather than tuples — `parseRows()` normalises
 * both forms into an array of `Record<string, unknown>`.
 */
export const RotamapCentralApiSchema = z
  .object({
    columns: z.array(z.object({ field_name: z.unknown() }).passthrough()).min(1),
    rows: z.array(z.unknown()),
  })
  .passthrough();

export type RotamapCentralApiResponse = z.infer<typeof RotamapCentralApiSchema>;

/**
 * Union of every top-level JSON shape parseRows() will accept:
 *   - bare array of row objects
 *   - Rotamap central_api tabular object
 *   - any other object (probed for `data`/`rows`/`results`/... wrappers)
 */
export const RowsWrapperSchema = z.union([
  z.array(z.record(z.unknown())),
  RotamapCentralApiSchema,
  z.record(z.unknown()),
]);

export type RowsWrapper = z.infer<typeof RowsWrapperSchema>;

// ---------------------------------------------------------------------------
// Row-level schemas (per report type)
//
// Every field is optional and passthrough is enabled — the CLWRota tenant
// configures which fields the report actually emits, and downstream code
// uses `pick()` alias arrays to resolve legacy field names.
// ---------------------------------------------------------------------------

const nullableString = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();

/** A row from the CLWRota `staff` / people report. */
export const ClwRotaStaffRowSchema = z
  .object({
    // Names — canonical + legacy aliases
    first_name: nullableString,
    firstname: nullableString,
    given_name: nullableString,
    forename: nullableString,
    last_name: nullableString,
    lastname: nullableString,
    surname: nullableString,
    family_name: nullableString,
    // Identity
    email: nullableString,
    "person.email": nullableString,
    gmc_number: nullableString,
    gmc: nullableString,
    // Employment window
    start_date: nullableString,
    end_date: nullableString,
    // Role / grade
    grade: nullableString,
    training_level: nullableString,
    "role_category.code": nullableString,
  })
  .passthrough();

export type ClwRotaStaffRow = z.infer<typeof ClwRotaStaffRowSchema>;

/** A row from the CLWRota rota / assignments report. */
export const ClwRotaRotaRowSchema = z
  .object({
    date: nullableString,
    session_date: nullableString,
    rota_date: nullableString,
    Date: nullableString,
    session: nullableString,
    "person.email": nullableString,
    "person.first_name": nullableString,
    "person.last_name": nullableString,
    "person.rota_name": nullableString,
    person: nullableString,
    email: nullableString,
    theatre: nullableString,
    theatre_name: nullableString,
    specialty: nullableString,
    specialty_name: nullableString,
    consultant: nullableString,
    role: nullableString,
    duty_type: nullableString,
    notes: nullableString,
    id: nullableString,
    rota_id: nullableString,
    assignment_id: nullableString,
    external_id: nullableString,
  })
  .passthrough();

export type ClwRotaRotaRow = z.infer<typeof ClwRotaRotaRowSchema>;

/** A row from the CLWRota `leave_events` report. */
export const ClwRotaLeaveRowSchema = z
  .object({
    "person.email": nullableString,
    "person.local_id": nullableString,
    "person.esr_employee_number": nullableString,
    "person.first_name": nullableString,
    "person.last_name": nullableString,
    "person.rota_name": nullableString,
    email: nullableString,
    person_email: nullableString,
    start_time: nullableString,
    end_time: nullableString,
    date: nullableString,
    duration: nullableString,
    "leave_type.name": nullableString,
    "leave_request.local_id": nullableString,
    "leave_request.state": nullableString,
    "leave_request.start_date": nullableString,
    "leave_request.end_date": nullableString,
    "leave_request.details": nullableString,
    "leave_submittal.state": nullableString,
  })
  .passthrough();

export type ClwRotaLeaveRow = z.infer<typeof ClwRotaLeaveRowSchema>;

/** A single parsed row — used when a report has no dedicated row schema. */
export const ClwRotaGenericRowSchema = z.record(z.unknown());
export type ClwRotaGenericRow = z.infer<typeof ClwRotaGenericRowSchema>;

// ---------------------------------------------------------------------------
// Parsed result type
// ---------------------------------------------------------------------------

/**
 * Structured result of parseRows(). `parseError` is a human-readable diagnostic
 * used by the sync UI when the upstream body is malformed; an empty
 * `rows` array with a non-null `parseError` means "upstream returned data we
 * couldn't decode" (as opposed to "upstream returned nothing").
 */
export type ParsedRowsResult = {
  rows: ClwRotaGenericRow[];
  parseError: string | null;
};
