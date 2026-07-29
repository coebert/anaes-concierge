// Real-shaped CLWRota rows that the tutorial audit was silently missing
// before we widened the free-text `pick` list and detection scope. Each
// fixture mirrors an actual upstream row observed during debugging where
// the tutorial topic lived in a field OTHER than `notes` — the source of
// the "audit finds no tutorials" regression.
//
// Keep these as plain objects (Record<string, unknown>) so `pick()` and
// the classifier run against the exact CLWRota shape rather than a
// pre-normalised app row.

export type MissedTutorialFixture = {
  name: string;
  // Raw upstream row as CLWRota returned it.
  row: Record<string, unknown>;
  // Field where the tutorial phrase actually lives — documented so a
  // future regression trivially points to which `pick` alias broke.
  sourceField: string;
  // The tutorial phrase we expect the sync's `pick` to surface into
  // rota_assignments.notes.
  expectedNoteContains: string;
  // Upstream role/duty text — usually generic ("SPA"/"Consultant") which
  // is why detection MUST rely on the free-text field, not the role.
  role: string;
};

export const MISSED_TUTORIAL_ROWS: MissedTutorialFixture[] = [
  {
    name: "SPA row with tutorial topic in top-level `description`",
    sourceField: "description",
    expectedNoteContains: "Tutorial: airway management",
    role: "SPA",
    row: {
      id: "clw-1001",
      date: "2026-02-03",
      "person.rota_name": "Dr A Consultant",
      "person.email": "a.consultant@example.nhs.uk",
      slot_titles: "SPA",
      description: "Tutorial: airway management",
    },
  },
  {
    name: "Consultant row with tutorial in nested `session.description`",
    sourceField: "session.description",
    expectedNoteContains: "Tutorial: regional anaesthesia",
    role: "Consultant",
    row: {
      id: "clw-1002",
      date: "2026-02-04",
      "person.rota_name": "Dr B Consultant",
      slot_titles: "Consultant",
      session: { description: "Tutorial: regional anaesthesia" },
    },
  },
  {
    name: "SPA row with tutorial phrase in `activity`",
    sourceField: "activity",
    expectedNoteContains: "Departmental teaching",
    role: "SPA",
    row: {
      id: "clw-1003",
      date: "2026-02-05",
      "person.rota_name": "Dr C SAS",
      slot_titles: "SPA",
      activity: "Departmental teaching",
    },
  },
  {
    name: "Nested assignment.activity tutorial row",
    sourceField: "assignment.activity",
    expectedNoteContains: "Tutorial/SPA",
    role: "Consultant",
    row: {
      id: "clw-1004",
      date: "2026-02-06",
      "person.rota_name": "Dr D Consultant",
      slot_titles: "Consultant",
      assignment: { activity: "Tutorial/SPA" },
    },
  },
  {
    name: "Row using `topic` free-text column",
    sourceField: "topic",
    expectedNoteContains: "Tutorial: obstetric emergencies",
    role: "SPA",
    row: {
      id: "clw-1005",
      date: "2026-02-07",
      "person.rota_name": "Dr E Consultant",
      slot_titles: "SPA",
      topic: "Tutorial: obstetric emergencies",
    },
  },
  {
    name: "Row using `session.title` free-text column",
    sourceField: "session.title",
    expectedNoteContains: "Lecture: capnography",
    role: "SPA",
    row: {
      id: "clw-1006",
      date: "2026-02-09",
      "person.rota_name": "Dr F Consultant",
      slot_titles: "SPA",
      session: { title: "Lecture: capnography" },
    },
  },
  {
    name: "extra_type.description carries the tutorial phrase",
    sourceField: "extra_type.description",
    expectedNoteContains: "Tutorial: paediatric airway",
    role: "Consultant",
    row: {
      id: "clw-1007",
      date: "2026-02-10",
      "person.rota_name": "Dr G Consultant",
      slot_titles: "Consultant",
      extra_type: { description: "Tutorial: paediatric airway" },
    },
  },
  // -------------------------------------------------------------------
  // `notes` variants — the original, "obvious" field. Kept here so a
  // regression that breaks the base case (not just the exotic nested
  // aliases) is caught by the same suite.
  // -------------------------------------------------------------------
  {
    name: "Consultant SPA row with tutorial phrase in top-level `notes`",
    sourceField: "notes",
    expectedNoteContains: "Tutorial: difficult airway",
    role: "SPA",
    row: {
      id: "clw-1008",
      date: "2026-02-11",
      "person.rota_name": "Dr H Consultant",
      slot_titles: "SPA",
      notes: "Tutorial: difficult airway",
    },
  },
  {
    name: "SAS row with tutorial phrase in singular `note`",
    sourceField: "note",
    expectedNoteContains: "Departmental teaching",
    role: "SPA",
    row: {
      id: "clw-1009",
      date: "2026-02-12",
      "person.rota_name": "Dr I SAS",
      slot_titles: "SPA",
      note: "Departmental teaching: ultrasound",
    },
  },
  {
    name: "Consultant row with tutorial phrase in `comment`",
    sourceField: "comment",
    expectedNoteContains: "Tutorial",
    role: "Consultant",
    row: {
      id: "clw-1010",
      date: "2026-02-13",
      "person.rota_name": "Dr J Consultant",
      slot_titles: "Consultant",
      comment: "Tutorial delivery — trainee teaching",
    },
  },
  {
    name: "Consultant row with tutorial phrase in nested `session.notes`",
    sourceField: "session.notes",
    expectedNoteContains: "Tutorial: crisis management",
    role: "Consultant",
    row: {
      id: "clw-1011",
      date: "2026-02-14",
      "person.rota_name": "Dr K Consultant",
      slot_titles: "Consultant",
      session: { notes: "Tutorial: crisis management" },
    },
  },
  {
    name: "Consultant row with tutorial phrase in nested `shift.notes`",
    sourceField: "shift.notes",
    expectedNoteContains: "Lecture",
    role: "Consultant",
    row: {
      id: "clw-1012",
      date: "2026-02-16",
      "person.rota_name": "Dr L Consultant",
      slot_titles: "Consultant",
      shift: { notes: "Lecture: pharmacology refresher" },
    },
  },
  {
    name: "Consultant row with tutorial phrase in nested `assignment.notes`",
    sourceField: "assignment.notes",
    expectedNoteContains: "Tutorial",
    role: "Consultant",
    row: {
      id: "clw-1013",
      date: "2026-02-17",
      "person.rota_name": "Dr M Consultant",
      slot_titles: "Consultant",
      assignment: { notes: "Tutorial: obstetric anaesthesia" },
    },
  },
  {
    name: "SPA row with `activity_name` carrying tutorial phrase",
    sourceField: "activity_name",
    expectedNoteContains: "Tutorial",
    role: "SPA",
    row: {
      id: "clw-1014",
      date: "2026-02-18",
      "person.rota_name": "Dr N Consultant",
      slot_titles: "SPA",
      activity_name: "Tutorial delivery",
    },
  },
  {
    name: "Consultant row with `duty.description` carrying tutorial phrase",
    sourceField: "duty.description",
    expectedNoteContains: "Departmental teaching",
    role: "Consultant",
    row: {
      id: "clw-1015",
      date: "2026-02-19",
      "person.rota_name": "Dr O Consultant",
      slot_titles: "Consultant",
      duty: { description: "Departmental teaching — grand round" },
    },
  },
];

// The exact `pick` alias list the sync uses for free-text/tutorial
// detection. Kept here (rather than imported) so a regression in the
// sync's alias list is caught by the fixture test rather than silently
// masked by importing the same array under test.
export const TUTORIAL_TEXT_PICK_KEYS = [
  "notes", "note", "comment", "comments",
  "session.notes", "session.note", "session.comment",
  "shift.notes", "shift.note", "shift.comment",
  "assignment.notes", "assignment.note", "assignment.comment",
  "activity", "activity.name", "activity_name",
  "session.activity", "shift.activity", "assignment.activity",
  "description", "session.description", "shift.description",
  "assignment.description", "duty.description", "role.description",
  "session_type.description", "assignment_type.description",
  "extra_type.description",
  "topic", "subject", "title", "session.title", "shift.title",
];
