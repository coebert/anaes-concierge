// Already in correct order — codemod must produce zero moves.
import { z } from "zod";

export const Schema = z.object({ id: z.string() });

export function parse(x: unknown) {
  return Schema.parse(x);
}
