/**
 * Tiny helpers for validating JSON from external sources (APIs, webhooks,
 * uploaded files). Built on zod so callers can supply any schema and get a
 * consistent { ok, data | error } result instead of relying on raw throws.
 */
import { z, type ZodSchema } from "zod";

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Parse a JSON string and validate against `schema`. Never throws. */
export function safeParseJson<T>(text: string, schema: ZodSchema<T>): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  return validateJson(raw, schema);
}

/** Validate already-parsed JSON against `schema`. Never throws. */
export function validateJson<T>(value: unknown, schema: ZodSchema<T>): ParseResult<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }
  return { ok: true, data: result.data };
}

/** Validate and throw a single-line, human-readable error on failure. */
export function assertJson<T>(value: unknown, schema: ZodSchema<T>, label = "payload"): T {
  const r = validateJson(value, schema);
  if (!r.ok) throw new Error(`Invalid ${label}: ${r.error}`);
  return r.data;
}

function formatZodError(err: z.ZodError): string {
  return err.errors
    .slice(0, 5)
    .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
    .join("; ");
}
