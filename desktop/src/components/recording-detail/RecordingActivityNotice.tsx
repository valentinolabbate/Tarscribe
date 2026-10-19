import { jobPhaseLabel } from "../../lib/format";
import type { JobEvent } from "../../lib/types";

export function RecordingActivityNotice({ activeJob, busy, pendingPhase, onOpenProcessing }: {
  activeJob?: JobEvent;
  busy: boolean;
  pendingPhase: string | null;
  onOpenProcessing: () => void;
}) {
  const failed = !busy && activeJob?.status === "failed";
  if (!busy && !failed) return null;
  const progress = activeJob?.status === "running" && !pendingPhase
    ? `${Math.round(activeJob.progress * 100)} %` : null;

  return (
    <div className={`recording-activity-notice${failed ? " failed" : ""}`}
      role={failed ? "alert" : "status"}>
      <div>
        <strong>{failed ? "Verarbeitung fehlgeschlagen"
          : `${jobPhaseLabel(pendingPhase ?? activeJob?.phase)}…`}</strong>
        {failed && activeJob?.error && <span>{activeJob.error}</span>}
      </div>
      {progress && <span className="recording-activity-progress">{progress}</span>}
      <button type="button" className="btn ghost" onClick={onOpenProcessing}>Verarbeitung öffnen</button>
    </div>
  );
}
