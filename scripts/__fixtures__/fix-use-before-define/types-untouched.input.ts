// Interfaces and type aliases must NEVER be reordered. The lint rule allows
// type references before definition (`ignoreTypeReferences: true`), and
// types are compile-time-only anyway — moving them is pointless churn.
export function format(u: User): string {
  return u.name;
}

export interface User {
  id: string;
  name: string;
}

export type UserId = User["id"];

export const ANON: User = { id: "0", name: "anon" };
