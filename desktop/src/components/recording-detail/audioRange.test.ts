import { describe, expect, it } from "vitest";
import { formatAudioTime, minimumAudioRange, moveAudioEdge, parseAudioTime } from "./audioRange";

describe("audio trim timecodes", () => {
  it("reads minutes, hours and fractional boundaries without treating them as decimal minutes", () => {
    expect(parseAudioTime("02:15")).toBe(135);
    expect(parseAudioTime("1:02:03.5")).toBe(3723.5);
    expect(parseAudioTime(" 00:04,25 ")).toBe(4.25);
    expect(parseAudioTime("75")).toBe(75);
  });

  it("rejects impossible or incomplete timecodes", () => {
    for (const text of ["", "1:", "-5", "NaN", "Infinity", "00:99", "1:60:00", "1:2:3:4", "Text"]) {
      expect(parseAudioTime(text)).toBeNull();
    }
  });

  it("rounds across minute and hour boundaries when displaying the selected time", () => {
    expect(formatAudioTime(59.98)).toBe("01:00");
    expect(formatAudioTime(3599.98)).toBe("1:00:00");
    expect(formatAudioTime(135.2)).toBe("02:15.2");
  });

  it("keeps drag and keyboard edits inside the recording and prevents crossed handles", () => {
    const range = { start: 4, end: 16 };
    expect(moveAudioEdge(range, "start", -10, 20)).toEqual({ start: 0, end: 16 });
    expect(moveAudioEdge(range, "end", 100, 20)).toEqual({ start: 4, end: 20 });
    expect(moveAudioEdge(range, "start", 18, 20).start).toBeCloseTo(15.9);
    expect(moveAudioEdge(range, "end", 0, 20).end).toBeCloseTo(4.1);
    expect(moveAudioEdge(range, "start", Number.NaN, 20)).toEqual(range);
  });

  it("allows very short recordings without a minimum longer than the entire audio", () => {
    expect(minimumAudioRange(0.04)).toBe(0.04);
    expect(moveAudioEdge({ start: 0, end: 0.04 }, "start", 0.03, 0.04))
      .toEqual({ start: 0, end: 0.04 });
  });
});
