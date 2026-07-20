import { useEffect, useState } from "react";
import type { QualityIssue } from "../../lib/types";

export function CorrectionEditor({
  issue,
  pending,
  onSave,
  onClose,
  onReplay,
}: {
  issue: QualityIssue;
  pending: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
  onReplay: () => void;
}) {
  const [value, setValue] = useState(issue.effective_text);
  useEffect(() => setValue(issue.effective_text), [issue.issue_id, issue.effective_text]);
  return (
    <div className="correction-editor" role="dialog" aria-label="Transkriptstelle korrigieren">
      <div className="correction-editor-head">
        <div><span className="quality-kicker">Stelle prüfen</span><strong>{issue.raw_text.trim()}</strong></div>
        <button className="icon-btn" onClick={onClose} aria-label="Korrektureditor schließen">×</button>
      </div>
      <label>
        Korrigierter Text
        <input value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
      </label>
      <div className="correction-editor-actions">
        <button className="btn ghost" onClick={onReplay}>▶ Kontext hören</button>
        <button className="btn" disabled={pending || !value.trim()} onClick={() => onSave(value)}>
          {pending ? "Speichert …" : "Korrektur übernehmen"}
        </button>
      </div>
    </div>
  );
}
