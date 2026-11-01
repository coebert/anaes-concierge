/**
 * Explicitly-loose shape for hand-rolled test doubles (query-builder proxies,
 * route handler internals). Every property is itself a callable `Dyn`, so
 * mocks can chain arbitrarily without resorting to `any`. Test-only.
 */
export type Dyn = { [key: string]: Dyn } & ((...args: unknown[]) => Dyn);
