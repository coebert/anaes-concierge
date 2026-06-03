// Function declarations are hoisted by JS semantics and the lint rule allows
// using them before their textual definition (`functions: false`). The
// codemod must leave them alone, even though `helper` is referenced first.
export const result = helper(2);

export function helper(n: number) {
  return n * 2;
}
