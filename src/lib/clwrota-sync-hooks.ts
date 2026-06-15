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
} from "./clwrota.functions";

type SyncStaffResult = Awaited<ReturnType<typeof syncClwRotaStaff>>;
type SyncRotaResult = Awaited<ReturnType<typeof syncClwRotaRota>>;
type SyncLeaveResult = Awaited<ReturnType<typeof syncClwRotaLeave>>;

export function useSyncClwRotaStaff(): () => Promise<SyncStaffResult> {
  const fn = useServerFn(syncClwRotaStaff);
  return () => fn();
}

export function useSyncClwRotaRota(): () => Promise<SyncRotaResult> {
  const fn = useServerFn(syncClwRotaRota);
  return () => fn();
}

export function useSyncClwRotaLeave(): () => Promise<SyncLeaveResult> {
  const fn = useServerFn(syncClwRotaLeave);
  return () => fn();
}
