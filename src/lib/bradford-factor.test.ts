import { describe, it, expect } from "vitest";
import {
  computeBradfordFactor,
  bandFor,
  type BradfordSpell,
} from "./bradford-factor";

const ref = new Date(Date.UTC(2026, 5, 30)); // 30 Jun 2026

function spell(start: string, end: string, extra: Partial<BradfordSpell> = {}): BradfordSpell {
  return { start_date: start, end_date: end, ...extra };
}

describe("bandFor", () => {
  it("classifies scores into the standard bands", () => {
    expect(bandFor(0)).toBe("green");
    expect(bandFor(50)).toBe("green");
    expect(bandFor(51)).toBe("amber");
    expect(bandFor(200)).toBe("amber");
    expect(bandFor(201)).toBe("red");
    expect(bandFor(450)).toBe("red");
    expect(bandFor(451)).toBe("critical");
    expect(bandFor(10_000)).toBe("critical");
  });
});

describe("computeBradfordFactor", () => {
  it("returns zero when there are no spells", () => {
    expect(computeBradfordFactor([], ref)).toMatchObject({
      score: 0,
      spellCount: 0,
      totalDays: 0,
      band: "green",
    });
  });

  it("one 10-day spell => S=1, D=10, B = 1²*10 = 10 (green)", () => {
    const r = computeBradfordFactor(
      [spell("2026-06-01", "2026-06-10")],
      ref,
    );
    expect(r.spellCount).toBe(1);
    expect(r.totalDays).toBe(10);
    expect(r.score).toBe(10);
    expect(r.band).toBe("green");
  });

  it("ten 1-day spells => S=10, D=10, B = 100*10 = 1000 (critical)", () => {
    const spells = Array.from({ length: 10 }, (_, i) =>
      spell(`2026-0${1 + Math.floor(i / 4)}-${String(1 + (i % 4)).padStart(2, "0")}`,
             `2026-0${1 + Math.floor(i / 4)}-${String(1 + (i % 4)).padStart(2, "0")}`),
    );
    const r = computeBradfordFactor(spells, ref);
    expect(r.spellCount).toBe(10);
    expect(r.totalDays).toBe(10);
    expect(r.score).toBe(1000);
    expect(r.band).toBe("critical");
  });

  it("excludes spells outside the rolling 12-month window", () => {
    const r = computeBradfordFactor(
      [
        spell("2024-01-01", "2024-01-05"), // long before window
        spell("2026-01-15", "2026-01-15"), // in window
      ],
      ref,
    );
    expect(r.spellCount).toBe(1);
    expect(r.totalDays).toBe(1);
    expect(r.score).toBe(1);
  });

  it("clips a spell that straddles the window boundary", () => {
    // window ~= 01 Jul 2025 → 30 Jun 2026. Spell 28 Jun–5 Jul 2025 => 5 days in window.
    const r = computeBradfordFactor(
      [spell("2025-06-28", "2025-07-05")],
      ref,
    );
    expect(r.spellCount).toBe(1);
    expect(r.totalDays).toBe(5);
    expect(r.score).toBe(5);
  });

  it("applies half-day flags", () => {
    const r = computeBradfordFactor(
      [spell("2026-06-01", "2026-06-03", { half_day_end: true })],
      ref,
    );
    expect(r.totalDays).toBe(2.5); // 3 days − 0.5
  });

  it("many short spells score much higher than one long spell of the same days", () => {
    const oneLong = computeBradfordFactor(
      [spell("2026-06-01", "2026-06-10")],
      ref,
    );
    const fiveShort = computeBradfordFactor(
      [
        spell("2026-01-05", "2026-01-06"),
        spell("2026-02-10", "2026-02-11"),
        spell("2026-03-15", "2026-03-16"),
        spell("2026-04-20", "2026-04-21"),
        spell("2026-05-25", "2026-05-26"),
      ],
      ref,
    );
    expect(oneLong.totalDays).toBe(10);
    expect(fiveShort.totalDays).toBe(10);
    expect(fiveShort.score).toBeGreaterThan(oneLong.score);
    expect(fiveShort.score).toBe(250); // 5² * 10
    expect(oneLong.score).toBe(10);   // 1² * 10
  });
});
