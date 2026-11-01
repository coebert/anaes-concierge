/**
 * Explicitly-loose shape for hand-rolled test doubles (query-builder proxies,
 * route handler internals). Every property is itself a callable `Dyn`, so
 * mocks can chain arbitrarily without resorting to `any`. Test-only.
 */
export type Dyn = { [key: string]: Dyn } & ((...args: unknown[]) => Dyn);

/** Chainable PostgREST-style builder double: methods are assigned ad hoc. */
export type MockBuilder = Record<string, (...args: never[]) => unknown>;

/** `then` callback slot for thenable doubles. */
export type ThenCb = ((value: unknown) => unknown) | null | undefined;
