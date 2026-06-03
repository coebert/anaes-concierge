// Test files that interleave vi.mock() calls between imports must be left
// alone — the order is human-readable signal, even though Vitest hoists
// vi.mock() automatically at runtime.
import { describe, it, vi } from "vitest";

vi.mock("@/lib/foo", () => ({ foo: () => 1 }));

import { foo } from "@/lib/foo";

describe("foo", () => {
  it("returns 1", () => {
    foo();
  });
});
