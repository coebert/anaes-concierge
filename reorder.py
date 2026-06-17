import sys

with open('src/components/rota-views.tsx', 'r') as f:
    lines = f.readlines()

# 0-based indices
tbody_idx = 353  # line 354
spa_start = 452  # line 453
spa_end = 510    # line 511
extra_start = 511  # line 512
extra_end = 607    # line 608

# The new order for lines 453-608:
# 1. Obstetrics + ICU (from extra duties, minus consultant)
# 2. SPA + Admin (from spaAdmin)
# Consultant goes before theatres at line 354.

# We need to:
# A. Insert consultant row before theatres (at line 354)
# B. Replace lines 453-511 with obstetrics+ICU block
# C. Replace lines 512-608 with SPA+Admin block

# For A, we need to generate the consultant row JSX explicitly.
# For B and C, we can modify the existing mapped arrays.

# Since this is complex, let's just read the full file and use string replacement
# on the mapped arrays themselves.

content = ''.join(lines)

# Find the three row arrays by their unique comments/array shapes
# 1. SPA/Admin array
spa_comment = '            {/* SPA and Admin sessions — non-clinical, broken down per AM/PM. */}\n'
# 2. Extra duties array  
extra_comment = '            {/* Consultant in charge / Obstetrics / ICU — aggregated AM/PM rows. */}\n'

# We need to split the extra duties array into:
# - consultant array (to move before theatres)
# - obstetrics+icu array (to place after theatres)

# And move the SPA/Admin array to the bottom (after obstetrics+icu, before NHH).

# Given the complexity, let's just modify the file by reconstructing the tbody section.

# Find the start and end of the tbody content we need to rewrite.
# tbody starts at line 354 (0-based 353), ends at line 658 (0-based 657)
tbody_start = 353
tbody_end = 657  # line 658: </tbody>

before = ''.join(lines[:tbody_start+1])  # up to and including <tbody>
after = ''.join(lines[tbody_end:])        # from </tbody> onwards

# Theatre block (lines 355-452, 0-based 354-451)
theatre_block = ''.join(lines[354:452])  # lines 355-452

# We need to generate:
# 1. Consultant row (before theatres)
# 2. Theatre block
# 3. Obstetrics + ICU rows
# 4. SPA + Admin rows
# 5. NHH row

# NHH block (lines 609-657, 0-based 608-656)
nhh_block = ''.join(lines[608:657])

# Generate consultant row without border-t
consultant_row = '''            {/* Consultant in charge */}
            <tr key="consultant_in_charge" className="align-top bg-rose-500/5">
              <td className="border-r p-2 font-medium whitespace-nowrap">
                Consultant in charge
                <div className="text-[10px] text-muted-foreground">Site lead for the session</div>
              </td>
              {days.flatMap((d) =>
                (["am", "pm"] as SessionHalf[]).map((s) => {
                  const dayIso = iso(d);
                  const cell = (extraDuties ?? []).filter(
                    (a) => a.duty_type === "consultant_in_charge" && a.session_date === dayIso && a.session === s,
                  );
                  const sorted = [...cell].sort(
                    (a, b) => gradeRank(staffById(a.staff_id)?.grade) - gradeRank(staffById(b.staff_id)?.grade),
                  );
                  const isPm = s === "pm";
                  return (
                    <td
                      key={"consultant_in_charge-" + dayIso + s}
                      className={cn(
                        "min-w-[110px] border-b p-1.5 align-top",
                        isPm ? "border-r" : "border-r border-r-border/30",
                      )}
                    >
                      {sorted.length > 0 ? (
                        <div className="space-y-1">
                          {sorted.map((a) => {
                            const sp = staffById(a.staff_id);
                            const isConsultant = sp?.grade === "consultant";
                            const isTrainee = sp?.grade === "trainee";
                            return (
                              <Link
                                key={a.id}
                                to="/calendar/staff/$staffId"
                                params={{ staffId: a.staff_id }}
                                className={cn(
                                  "block truncate text-[10px] hover:underline",
                                  isConsultant && "font-bold",
                                  isTrainee && "text-blue-600 dark:text-blue-400",
                                )}
                              >
                                {staffName(a.staff_id)}
                                {isTrainee ? ` (${sp?.training_level || "Level unknown"})` : ""}
                              </Link>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="text-muted-foreground/40 text-[10px]">—</div>
                      )}
                    </td>
                  );
                }),
              )}
            </tr>
'''

# Generate obstetrics+ICU block using the same pattern as extra duties but without consultant
# We'll extract the array definition and map from the original extra block
extra_block_lines = lines[extra_start:extra_end+1]

# Find where the array objects end and .map begins
map_start = None
for i, line in enumerate(extra_block_lines):
    if ']).map' in line:
        map_start = i
        break

# The array is lines 1 to map_start-1 (line 1 is "{([" line)
array_lines = extra_block_lines[1:map_start]

# Filter out consultant_in_charge object
filtered_array = []
skip = 0
for line in array_lines:
    if 'consultant_in_charge' in line:
        skip = 1
        continue
    if skip:
        if line.strip() == '},':
            skip = 0
        continue
    filtered_array.append(line)

# Build the new extra block
new_extra_block = '            {/* Obstetrics and ICU */}\n'
new_extra_block += '            {([' + '\n'
for line in filtered_array:
    new_extra_block += line
new_extra_block += '            ] as const).map((row) => (\n'
for line in extra_block_lines[map_start+1:]:
    new_extra_block += line

# Generate SPA+Admin block using the original SPA block
spa_block_lines = lines[spa_start:spa_end+1]
new_spa_block = '            {/* SPA and Admin sessions — non-clinical, broken down per AM/PM. */}\n'
for line in spa_block_lines[1:]:
    new_spa_block += line

# Assemble the new tbody content
new_tbody = consultant_row + theatre_block + new_extra_block + new_spa_block + nhh_block

new_content = before + new_tbody + after

with open('src/components/rota-views.tsx', 'w') as f:
    f.write(new_content)

print("Done")
