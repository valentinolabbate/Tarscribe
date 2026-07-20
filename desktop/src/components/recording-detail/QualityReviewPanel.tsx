import type { QualityIssue, QualityReport } from "../../lib/types";
import { timestamp } from "./model";

export function QualityReviewPanel({
  report,
  selectedId,
  onSelect,
}: {
  report: QualityReport;
  selectedId: string | null;
  onSelect: (issue: QualityIssue) => void;
}) {
  const { quality, issues } = report;
  return (
    <aside className="quality-review" aria-label="Transkript prüfen">
      <div className="quality-review-head">
        <div>
          <span className="quality-kicker">Qualitätsprüfung</span>
          <strong>{quality.open_count ? `${quality.open_count} Stellen prüfen` : "Keine offenen Stellen"}</strong>
        </div>
        {quality.critical_count > 0 && <span className="quality-critical-count">{quality.critical_count} kritisch</span>}
      </div>
      {quality.coverage === "unavailable" && (
        <p className="quality-coverage">Dieses Modell liefert keine Wort-Konfidenz.</p>
      )}
      <div className="quality-issue-list">
        {issues.map((issue) => (
          <button
            className={`quality-issue ${selectedId === issue.issue_id ? "selected" : ""}`}
            key={issue.issue_id}
            onClick={() => onSelect(issue)}
          >
            <span className={`quality-severity ${issue.severity}`}>{issue.severity === "critical" ? "Kritisch" : "Prüfen"}</span>
            <strong>{issue.raw_text.trim()}</strong>
            <small>{timestamp(issue.start_sec)} · {issue.min_confidence == null ? "Konfidenz nicht verfügbar" : `${Math.round(issue.min_confidence * 100)} % Konfidenz`}</small>
          </button>
        ))}
      </div>
    </aside>
  );
}
