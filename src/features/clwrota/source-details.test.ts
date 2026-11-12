import { describe, expect, it } from "vitest";
import {
  buildSourceDetailRecords,
  extractAssignmentSourceDetails,
  persistAssignmentSourceDetails,
  MAX_DETAIL_CHARS,
  type SourceDetailsClient,
} from "./source-details";

// Synthetic feed row in the Central API assignments shape (nested objects).
const feedRow = (o: Record<string, unknown> = {}) => ({
  date: "2030-01-07",
  start_time: "2030-01-07T08:00:00+00:00",
  end_time: "2030-01-07T20:00:00+00:00",
  duration: "12:00:00",
  state: "planned",
  rota_status: "Not setup",
  pa_value: 3,
  slot_titles: "Synthetic ICU cover",
  slot_notes: "Synthetic list note",
  slot_speciality: "ICU",
  place: { name: "Synthetic ICU", local_id: 42, additional_info: "Synthetic place note" },
  place_category: { name: "Oncall" },
  role: { name: "Consultant" },
  role_category: { name: "Consultant" },
  assignment_type: { name: "Normal" },
  extra_type: { name: null, description: "" },
  session: { rota_label: "AM" },
  person: {
    email: "synthetic@example.test",
    mobile_number: "07000000000",
    rota_name: "Dr Synthetic",
  },
  ...o,
});

describe("extractAssignmentSourceDetails", () => {
  it("keeps title, list note and place note separately, with typed times", () => {
    const d = extractAssignmentSourceDetails(feedRow());
    expect(d.slot_titles).toEqual(["Synthetic ICU cover"]);
    expect(d.slot_notes).toEqual(["Synthetic list note"]);
    expect(d.place_notes).toEqual(["Synthetic place note"]);
    expect(d.place_name).toBe("Synthetic ICU");
    expect(d.place_local_id).toBe("42");
    expect(d.place_category).toBe("Oncall");
    expect(d.start_time).toBe("2030-01-07T08:00:00+00:00");
    expect(d.duration).toBe("12:00:00");
    expect(d.pa_value).toBe(3);
    expect(d.source_state).toBe("planned");
    expect(d.source_rota_status).toBe("Not setup");
    expect(d.extra_type_description).toBeNull();
  });

  it("never captures person contact details", () => {
    const json = JSON.stringify(extractAssignmentSourceDetails(feedRow()));
    expect(json).not.toContain("07000000000");
    expect(json).not.toContain("synthetic@example.test");
    expect(json).not.toContain("Dr Synthetic");
  });

  it("keeps several distinct values supplied as a list, dropping case/space repeats", () => {
    const d = extractAssignmentSourceDetails(
      feedRow({ slot_notes: ["Note A", "note  a", "Note B"] }),
    );
    expect(d.slot_notes).toEqual(["Note A", "Note B"]);
  });

  it("rejects malformed times and durations instead of storing them", () => {
    const d = extractAssignmentSourceDetails(
      feedRow({ start_time: "8am", duration: "four hours", pa_value: "x" }),
    );
    expect(d.start_time).toBeNull();
    expect(d.duration).toBeNull();
    expect(d.pa_value).toBeNull();
  });

  it("flags values cut to the storage limit", () => {
    const d = extractAssignmentSourceDetails(
      feedRow({ slot_notes: "x".repeat(MAX_DETAIL_CHARS + 5) }),
    );
    expect(d.slot_notes[0]).toHaveLength(MAX_DETAIL_CHARS);
    expect(d.values_truncated).toBe(true);
  });
});

describe("buildSourceDetailRecords", () => {
  it("attaches a feed row lost to the one-row-per-half rule to the row stored for that half", () => {
    const kept = {
      clwrota_external_id: "p1|2030-01-07|AM",
      duty_type: "medical_examiner",
      source_details: extractAssignmentSourceDetails(feedRow()),
    };
    const lost = {
      clwrota_external_id: "p1|2030-01-07|AM-other",
      duty_type: "theatre",
      source_details: extractAssignmentSourceDetails(
        feedRow({ slot_titles: "Synthetic list title", slot_notes: null }),
      ),
    };
    const r = buildSourceDetailRecords({
      stored: [kept],
      dropped: [{ dropped: lost, kept, reason: "duplicate_staff_session" }],
      nowIso: "2030-01-01T00:00:00Z",
    });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].collapsed_rows).toEqual([
      expect.objectContaining({
        duty_type: "theatre",
        slot_titles: ["Synthetic list title"],
        slot_notes: [],
        reason: "duplicate_staff_session",
      }),
    ]);
    expect(r.collapsedAttached).toBe(1);
  });
});

describe("persistAssignmentSourceDetails", () => {
  const client = (error: { code?: string; message?: string } | null): SourceDetailsClient => ({
    from: () => ({ upsert: async () => ({ error }) }),
  });
  const rec = buildSourceDetailRecords({
    stored: [
      {
        clwrota_external_id: "k",
        duty_type: "spa",
        source_details: extractAssignmentSourceDetails(feedRow()),
      },
    ],
    dropped: [],
    nowIso: "2030-01-01T00:00:00Z",
  }).records;

  it("reports not_installed when the table is absent (migration pending)", async () => {
    expect((await persistAssignmentSourceDetails(client({ code: "PGRST205" }), rec)).status).toBe(
      "not_installed",
    );
  });
  it("reports other failures as errors", async () => {
    const r = await persistAssignmentSourceDetails(
      client({ code: "23514", message: "check" }),
      rec,
    );
    expect(r.status).toBe("error");
  });
  it("writes every record", async () => {
    expect(await persistAssignmentSourceDetails(client(null), rec)).toEqual({
      status: "ok",
      written: 1,
    });
  });
});
