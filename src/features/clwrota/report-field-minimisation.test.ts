import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchReportRaw, withoutUnusedPersonalFields } from "./parsing";

const fieldsOf = (url: string) => new URL(url).searchParams.get("fields")!.split(",");

describe("withoutUnusedPersonalFields", () => {
  it("drops contact, login and pay fields but keeps what the import reads", () => {
    const url =
      "https://central.example/central_api/query/assignments?fields=date,person.email,person.local_id,person.mobile_number,person.last_login,person.sharing_mobile_number,slot_notes,extra_submittal.total_amount&start_date=2030-01-01";
    const f = fieldsOf(withoutUnusedPersonalFields(url));
    expect(f).toEqual(["date", "person.email", "person.local_id", "slot_notes"]);
  });

  it("handles the staff report's unprefixed names", () => {
    const f = fieldsOf(
      withoutUnusedPersonalFields(
        "https://c.example/central_api/query/people?fields=email,local_id,mobile_number,last_login,payscale,gmc_number",
      ),
    );
    expect(f).toEqual(["email", "local_id", "gmc_number"]);
  });

  it("leaves a URL without fields= (server default) unchanged", () => {
    const url = "https://c.example/central_api/query/people?start_date=2030-01-01";
    expect(withoutUnusedPersonalFields(url)).toBe(url);
  });
});

describe("fetchReportRaw", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never requests the dropped fields", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(u);
      return new Response("[]", { status: 200 });
    });
    await fetchReportRaw(
      "https://c.example/central_api/query/assignments?fields=date,person.mobile_number,person.email",
      "k",
      { extendFutureWindow: false },
    );
    expect(fieldsOf(seen[0])).toEqual(["date", "person.email"]);
  });
});
