import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QualityIssue, WordSeg } from "../../lib/types";
import { QualityText } from "./QualityText";

function word(text: string, index: number): WordSeg {
  return {
    start: index,
    end: index + 0.5,
    text,
    confidence: 0.2,
    source_start_idx: index,
    source_end_idx: index,
  };
}

function issue(index: number): QualityIssue {
  const text = index === 1 ? " funktion" : " um";
  return {
    issue_id: `issue-${index}`,
    reason_codes: ["low_confidence"],
    severity: index === 1 ? "critical" : "review",
    start_word_idx: index,
    end_word_idx: index,
    start_sec: index,
    end_sec: index + 0.5,
    raw_text: text,
    effective_text: text,
    min_confidence: 0.2,
    mean_confidence: 0.2,
    quality_score: 0.2,
    correction_id: null,
  };
}

describe("QualityText", () => {
  it("preserves leading word spaces outside interactive issue buttons", () => {
    const words = [word("diese", 0), word(" funktion", 1), word(" um", 2), word(" das Transkript", 3)];
    const issues = [issue(1), issue(2)];

    const html = renderToStaticMarkup(
      <QualityText
        words={words}
        issues={issues}
        onSelect={() => undefined}
        onAcknowledge={() => undefined}
      />,
    );

    expect(html.replace(/<[^>]+>/g, "")).toBe(words.map((item) => item.text).join(""));
    expect(html).toMatch(
      /<span>diese<\/span> <button[^>]*>funktion<\/button> <button[^>]*>um<\/button>/,
    );
    expect(html.match(/Doppelklick: stimmt/g)).toHaveLength(2);
  });

  it("marks exactly the selected issue as active and accessible", () => {
    const words = [word("diese", 0), word(" funktion", 1), word(" um", 2)];
    const issues = [issue(1), issue(2)];

    const html = renderToStaticMarkup(
      <QualityText
        words={words}
        issues={issues}
        onSelect={() => undefined}
        onAcknowledge={() => undefined}
        selectedId="issue-2"
      />,
    );

    expect(html).toMatch(/class="quality-word quality-word-review selected"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/class="quality-word quality-word-critical"[^>]*aria-pressed="false"/);
  });
});
