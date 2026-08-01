import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QualityIssue, QualityReport } from "../../lib/types";
import { QualityReviewPanel } from "./QualityReviewPanel";

function issue(id: string, severity: QualityIssue["severity"], text: string): QualityIssue {
  return {
    issue_id: id,
    reason_codes: ["low_confidence"],
    severity,
    start_word_idx: id === "critical" ? 1 : 2,
    end_word_idx: id === "critical" ? 1 : 2,
    start_sec: id === "critical" ? 4 : 8,
    end_sec: id === "critical" ? 4.5 : 8.5,
    raw_text: ` ${text}`,
    effective_text: ` ${text}`,
    min_confidence: severity === "critical" ? 0.2 : 0.48,
    mean_confidence: severity === "critical" ? 0.2 : 0.48,
    quality_score: severity === "critical" ? 0.2 : 0.48,
    correction_id: null,
  };
}

const criticalIssue = issue("critical", "critical", "Kopfhälter");
const reviewIssue = issue("review", "review", "Worttrennung");

const report: QualityReport = {
  transcript_id: 7,
  revision: 0,
  quality: {
    coverage: "word_confidence",
    open_count: 2,
    critical_count: 1,
    unknown_confidence_count: 0,
  },
  issues: [criticalIssue, reviewIssue],
  corrections: [],
};

function renderPanel(editingId: string | null = null) {
  return renderToStaticMarkup(
    <QualityReviewPanel
      report={report}
      selectedId="critical"
      editingId={editingId}
      acknowledging={false}
      correcting={false}
      onSelect={vi.fn()}
      onAcknowledge={vi.fn()}
      onEdit={vi.fn()}
      onReplay={vi.fn()}
      onSave={vi.fn()}
      onCancelEdit={vi.fn()}
    />,
  );
}

describe("QualityReviewPanel", () => {
  it("uses honest uncertainty labels and exposes direct review actions", () => {
    const html = renderPanel();

    expect(html).toContain("Niedrige Erkennungssicherheit ist noch kein bestätigter Fehler.");
    expect(html).toContain(">Sehr unsicher<");
    expect(html).toContain(">Unsicher<");
    expect(html).not.toContain(">Kritisch<");
    expect(html.match(/>\u25b6 Hören</g)).toHaveLength(2);
    expect(html.match(/>\u2713 Stimmt</g)).toHaveLength(2);
    expect(html.match(/>\u00c4ndern</g)).toHaveLength(2);
    expect(html).toMatch(
      /class="quality-issue selected"><button class="quality-issue-main"[^>]*aria-pressed="true"/,
    );
    expect(html).toMatch(
      /class="quality-issue "><button class="quality-issue-main"[^>]*aria-pressed="false"/,
    );
  });

  it("renders correction controls inline for the edited issue", () => {
    const html = renderPanel("critical");

    expect(html).toMatch(
      /class="quality-issue selected">[\s\S]*class="correction-editor" role="group"/,
    );
    expect(html).toContain("Text ändern");
    expect(html).toContain("Korrigierter Text");
    expect(html).toContain("value=\" Kopfhälter\"");
    expect(html).toContain("▶ Kontext hören");
    expect(html).toContain("Änderung übernehmen");
    expect(html).toContain('aria-expanded="true"');
  });
});
