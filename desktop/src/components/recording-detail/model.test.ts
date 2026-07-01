import { describe, expect, it } from "vitest";
import type { WordSeg } from "../../lib/types";
import { colorFor, groupWordsIntoSentences, timestamp } from "./model";

function word(text: string, start: number, end: number): WordSeg {
  return { text, start, end, confidence: null };
}

describe("recording detail model", () => {
  it("formats timestamps as m:ss", () => {
    expect(timestamp(7.8)).toBe("0:07");
    expect(timestamp(125.2)).toBe("2:05");
  });

  it("keeps speaker colors stable by label order", () => {
    expect(colorFor("B", ["A", "B", "C"])).toBe("#2563eb");
    expect(colorFor("unknown", ["A", "B"])).toBe("#0f766e");
  });

  it("groups transcript words on punctuation and pauses", () => {
    const sentences = groupWordsIntoSentences([
      word("Hallo ", 0, 0.2),
      word("Welt.", 0.2, 0.5),
      word(" Danach ", 1.6, 1.9),
      word("gehen ", 1.9, 2.1),
      word("wir ", 2.1, 2.3),
      word("weiter", 2.3, 2.6),
      word(" Jetzt ", 3.7, 3.9),
      word("geht", 3.9, 4.1),
      word(" es", 4.1, 4.3),
    ]);

    expect(sentences).toEqual([
      { start: 0, end: 0.5, text: "Hallo Welt." },
      { start: 1.6, end: 2.6, text: "Danach gehen wir weiter" },
      { start: 3.7, end: 4.3, text: "Jetzt geht es" },
    ]);
  });
});
