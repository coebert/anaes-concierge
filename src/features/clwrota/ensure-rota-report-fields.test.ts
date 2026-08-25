import { describe, it, expect } from "vitest";
import { ensureRotaReportFields } from "./parsing";

describe("ensureRotaReportFields", () => {
  it("appends accepted tutorial fields to an explicit fields= param", () => {
    const url =
      "https://central.example/api/rota.json?fields=date,session,person.email,role";
    const out = ensureRotaReportFields(url);
    const params = new URL(out).searchParams.get("fields")!.split(",");
    expect(params).toContain("slot_notes");
    expect(params).toContain("slot_titles");
    expect(params).toContain("place.name");
    expect(params).toContain("place.additional_info");
    // keeps existing fields
    expect(params).toContain("date");
    expect(params).toContain("role");
  });

  it("is a no-op when fields= is not set (server returns all fields)", () => {
    const url = "https://central.example/api/rota.json?start_date=2026-01-01";
    expect(ensureRotaReportFields(url)).toBe(url);
  });

  it("is idempotent", () => {
    const url =
      "https://central.example/api/rota.json?fields=date,session,notes";
    expect(ensureRotaReportFields(ensureRotaReportFields(url))).toBe(
      ensureRotaReportFields(url),
    );
  });

  it("returns the input unchanged when the URL is malformed", () => {
    expect(ensureRotaReportFields("not a url")).toBe("not a url");
    expect(ensureRotaReportFields("")).toBe("");
  });
});
