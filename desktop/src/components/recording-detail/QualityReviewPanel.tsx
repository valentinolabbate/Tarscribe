import type { QualityIssue, QualityReport } from "../../lib/types";
import { CorrectionEditor } from "./CorrectionEditor";
import { timestamp } from "./model";

export function QualityReviewPanel({
  report,
  selectedId,
  editingId,
  acknowledging,
  correcting,
  onSelect,
  onAcknowledge,
  onEdit,
  onReplay,
  onSave,
  onCancelEdit,
}: {
  report: QualityReport;
  selectedId: string | null;
  editingId: string | null;
  acknowledging: boolean;
  correcting: boolean;
  onSelect: (issue: QualityIssue) => void;
  onAcknowledge: (issue: QualityIssue) => void;
  onEdit: (issue: QualityIssue) => void;
  onReplay: (issue: QualityIssue) => void;
  onSave: (issue: QualityIssue, text: string) => void;
  onCancelEdit: () => void;
}) {
  const { quality, issues } = report;
  return (
    <aside className="quality-review" aria-label="Transkript prüfen">
      <div className="quality-review-head">
        <div>
          <span className="quality-kicker">Qualitätsprüfung</span>
          <strong>{quality.open_count ? `${quality.open_count} Stellen prüfen` : "Keine offenen Stellen"}</strong>
        </div>
        {quality.critical_count > 0 && <span className="quality-critical-count">{quality.critical_count} sehr unsicher</span>}
      </div>
      {quality.open_count > 0 && (
        <p className="quality-review-help">Niedrige Erkennungssicherheit ist noch kein bestätigter Fehler.</p>
      )}
      {quality.coverage === "unavailable" && (
        <p className="quality-coverage">Dieses Modell liefert keine Wort-Konfidenz.</p>
      )}
      <div className="quality-issue-list">
        {issues.map((issue) => (
          <QualityIssueRow
            key={issue.issue_id}
            issue={issue}
            selected={selectedId === issue.issue_id}
            editing={editingId === issue.issue_id}
            acknowledging={acknowledging}
            correcting={correcting}
            onSelect={onSelect}
            onAcknowledge={onAcknowledge}
            onEdit={onEdit}
            onReplay={onReplay}
            onSave={onSave}
            onCancelEdit={onCancelEdit}
          />
        ))}
      </div>
    </aside>
  );
}

function QualityIssueRow({
  issue,
  selected,
  editing,
  acknowledging,
  correcting,
  onSelect,
  onAcknowledge,
  onEdit,
  onReplay,
  onSave,
  onCancelEdit,
}: {
  issue: QualityIssue;
  selected: boolean;
  editing: boolean;
  acknowledging: boolean;
  correcting: boolean;
  onSelect: (issue: QualityIssue) => void;
  onAcknowledge: (issue: QualityIssue) => void;
  onEdit: (issue: QualityIssue) => void;
  onReplay: (issue: QualityIssue) => void;
  onSave: (issue: QualityIssue, text: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className={`quality-issue ${selected ? "selected" : ""}`}>
      <button
        className="quality-issue-main"
        onClick={() => onSelect(issue)}
        aria-pressed={selected}
      >
        <span className={`quality-severity ${issue.severity}`}>
          {issue.severity === "critical" ? "Sehr unsicher" : "Unsicher"}
        </span>
        <strong>{issue.raw_text.trim()}</strong>
        <small>
          {timestamp(issue.start_sec)} · {issue.min_confidence == null
            ? "Konfidenz nicht verfügbar"
            : `${Math.round(issue.min_confidence * 100)} % Konfidenz`}
        </small>
      </button>
      <div className="quality-issue-actions" role="group" aria-label={`Aktionen für ${issue.raw_text.trim()}`}>
        <button className="quality-action listen" onClick={() => onReplay(issue)} aria-label="Audiokontext hören">
          ▶ Hören
        </button>
        <button
          className="quality-action accept"
          onClick={() => onAcknowledge(issue)}
          disabled={acknowledging || correcting}
        >
          ✓ Stimmt
        </button>
        <button
          className="quality-action edit"
          onClick={() => onEdit(issue)}
          disabled={acknowledging || correcting}
          aria-expanded={editing}
        >
          Ändern
        </button>
      </div>
      {editing && (
        <CorrectionEditor
          issue={issue}
          pending={correcting}
          onClose={onCancelEdit}
          onReplay={() => onReplay(issue)}
          onSave={(text) => onSave(issue, text)}
        />
      )}
    </div>
  );
}
