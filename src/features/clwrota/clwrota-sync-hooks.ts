/**
 * Typed no-arg wrappers around the CLWRota sync server functions.
 *
 * These exist to make `syncStaff({})` / `syncRota({})` / `syncLeave({})` a
 * compile-time error. Passing `{}` to a TanStack `createServerFn` call is
 * interpreted as the request-options bag (`{ data, headers, signal, ... }`)
 * and silently overrides headers contributed by global middleware — most
 * notably the `Authorization: Bearer …` header attached by
 * `attachSupabaseAuth`. Server-side `requireSupabaseAuth` then throws
 * "Unauthorized: No authorization header provided".
 *
 * By exposing each sync as a `() => Promise<R>` hook with zero parameters,
 * any caller that supplies an argument fails typecheck:
 *   const syncStaff = useSyncClwRotaStaff();
 *   syncStaff({}); // TS2554: Expected 0 arguments, but got 1.
 */
import { useServerFn } from "@tanstack/react-start";
import {
  syncClwRotaStaff,
  syncClwRotaRota,
  syncClwRotaLeave,
  performStaffSync,
  performRotaSync,
  performLeaveSync,
} from "./clwrota.functions";

// Result shapes match the underlying handler bodies, which simply return the
// performXxxSync helpers. Sourcing types from the helpers keeps the rich
// payload type (counts, sample keys, diagnostics) for downstream consumers.
export type SyncStaffResult = Awaited<ReturnType<typeof performStaffSync>>;
export type SyncRotaResult = Awaited<ReturnType<typeof performRotaSync>>;
export type SyncLeaveResult = Awaited<ReturnType<typeof performLeaveSync>>;

export function useSyncClwRotaStaff(): () => Promise<SyncStaffResult> {
  const fn = useServerFn(syncClwRotaStaff);
  return () => fn() as Promise<SyncStaffResult>;
}

export function useSyncClwRotaRota(): () => Promise<SyncRotaResult> {
  const fn = useServerFn(syncClwRotaRota);
  return () => fn() as Promise<SyncRotaResult>;
}

export function useSyncClwRotaLeave(): () => Promise<SyncLeaveResult> {
  const fn = useServerFn(syncClwRotaLeave);
  return () => fn() as Promise<SyncLeaveResult>;
}
