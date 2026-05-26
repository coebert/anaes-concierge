export type SpecialtyProgress = {
  specialty_id: string;
  specialty_name: string;
  required_solo: number;
  required_supervised: number;
  required_sessions: number;
  done_solo: number;
  done_supervised: number;
  done_total: number;
  percent: number;
};

export function computeProgress(
  targets: Array<{
    specialty_id: string;
    specialty_name: string;
    required_solo: number;
    required_supervised: number;
    required_sessions: number;
  }>,
  assignments: Array<{
    specialty_id: string | null;
    role_on_list: string;
  }>,
): SpecialtyProgress[] {
  return targets.map((t) => {
    const filtered = assignments.filter((a) => a.specialty_id === t.specialty_id);
    const done_solo = filtered.filter((a) => a.role_on_list === "solo").length;
    const done_supervised = filtered.filter((a) => a.role_on_list === "supervised").length;
    const done_total = done_solo + done_supervised;
    const requiredTotal =
      t.required_sessions || t.required_solo + t.required_supervised;
    const soloPct = t.required_solo ? Math.min(done_solo / t.required_solo, 1) : 1;
    const supPct = t.required_supervised
      ? Math.min(done_supervised / t.required_supervised, 1)
      : 1;
    const totalPct = requiredTotal ? Math.min(done_total / requiredTotal, 1) : 1;
    const percent = Math.round(((soloPct + supPct + totalPct) / 3) * 100);
    return {
      ...t,
      done_solo,
      done_supervised,
      done_total,
      percent,
    };
  });
}
