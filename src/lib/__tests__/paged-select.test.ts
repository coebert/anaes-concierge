import { describe, expect, it } from "vitest";
import { pagedRows, pagedSelect } from "@/lib/paged-select";

type Call = { m: string; a: unknown[] };

/** Synthetic PostgREST builder: records calls, serves `rows` by range. */
function fakeClient(
  rows: { id: string }[],
  opts: { failFrom?: number; delayMs?: number } = {},
) {
  const log: Call[][] = [];
  return {
    log,
    client: {
      from() {
        const calls: Call[] = [];
        log.push(calls);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b: any = new Proxy(
          {},
          {
            get(_t, prop: string) {
              return (...a: unknown[]) => {
                calls.push({ m: prop, a });
                if (prop !== "range") return b;
                const [from, to] = a as [number, number];
                return new Promise((res) =>
                  setTimeout(
                    () =>
                      res(
                        opts.failFrom !== undefined && from >= opts.failFrom
                          ? { data: null, error: { message: `page at ${from} failed` } }
                          : { data: rows.slice(from, to + 1), error: null },
                      ),
                    opts.delayMs ?? 0,
                  ),
                );
              };
            },
          },
        );
        return b;
      },
    },
  };
}

const make = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}` }));

describe("pagedSelect", () => {
  it("returns every row across several 1,000-row pages, in stable order", async () => {
    const { client, log } = fakeClient(make(2501), { delayMs: 2 });
    const out = await pagedSelect<{ id: string }>("rota_assignments", "id", {
      order: ["session_date", "id"],
      client,
    });
    expect(out).toHaveLength(2501);
    expect(out[2500].id).toBe("r02500");
    // Every page applied the full stable order, ending with the unique id.
    for (const calls of log) {
      const orders = calls.filter((c) => c.m === "order").map((c) => c.a[0]);
      expect(orders).toEqual(["session_date", "id"]);
    }
  });

  it("applies filters and descending order", async () => {
    const { client, log } = fakeClient(make(3));
    await pagedSelect("leave_requests", "id", {
      filter: (q) => q.eq("status", "approved"),
      order: ["-start_date", "id"],
      client,
    });
    const calls = log[0];
    expect(calls.find((c) => c.m === "eq")?.a).toEqual(["status", "approved"]);
    expect(calls.find((c) => c.m === "order")?.a).toEqual(["start_date", { ascending: false }]);
  });

  it("throws when page 2 fails instead of returning page 1", async () => {
    const { client } = fakeClient(make(1500), { failFrom: 1000 });
    await expect(
      pagedSelect("rota_assignments", "id", { order: ["id"], client }),
    ).rejects.toThrow();
  });

  it("returns exactly-at-cap results but throws above the cap", async () => {
    const atCap = fakeClient(make(1000));
    await expect(
      pagedSelect("t", "id", { order: ["id"], maxRows: 1000, client: atCap.client }),
    ).resolves.toHaveLength(1000);
    const over = fakeClient(make(1001));
    await expect(
      pagedSelect("t", "id", { order: ["id"], maxRows: 1000, client: over.client }),
    ).rejects.toThrow();
  });

  it("requires an order", async () => {
    const { client } = fakeClient(make(1));
    await expect(pagedSelect("t", "id", { order: [], client })).rejects.toThrow(RangeError);
  });

  it("returns a true empty list for zero rows", async () => {
    const { client } = fakeClient([]);
    await expect(pagedSelect("t", "id", { order: ["id"], client })).resolves.toEqual([]);
  });
});

describe("pagedRows", () => {
  it("wraps results as { data, error: null }", async () => {
    const { client } = fakeClient(make(1200));
    const res = await pagedRows("profiles", "id", { order: ["id"], client });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1200);
  });
});
