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

// Derive result types from the bound RPC fn (the .handler return type), so
// the hooks expose the same shape callers previously read from the mutation.
type Bound<T> = ReturnType<typeof useServerFn<T extends (...args: never) => unknown ? T : never>>;
type ResultOf<T> = Awaited<ReturnType<Bound<T>>>;

export function useSyncClwRotaStaff(): () => Promise<ResultOf<typeof syncClwRotaStaff>> {
  const fn = useServerFn(syncClwRotaStaff);
  return () => fn();
}

export function useSyncClwRotaRota(): () => Promise<ResultOf<typeof syncClwRotaRota>> {
  const fn = useServerFn(syncClwRotaRota);
  return () => fn();
}

export function useSyncClwRotaLeave(): () => Promise<ResultOf<typeof syncClwRotaLeave>> {
  const fn = useServerFn(syncClwRotaLeave);
  return () => fn();
}
