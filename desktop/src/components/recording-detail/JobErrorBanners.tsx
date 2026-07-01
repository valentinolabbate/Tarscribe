import type { JobEvent } from "../../lib/types";

export function JobErrorBanners({
  activeJob,
  running,
  retryPending,
  transcribePending,
  hasTranscript,
  onRetry,
  onRetranscribe,
}: {
  activeJob?: JobEvent;
  running: boolean;
  retryPending: boolean;
  transcribePending: boolean;
  hasTranscript: boolean;
  onRetry: (jobId: number) => void;
  onRetranscribe: () => void;
}) {
  return (
    <>
      {activeJob?.status === "failed" && activeJob.phase === "diarization" && (
        <div className="detail-error detail-error-box detail-error-row">
          <span>Diarisierung fehlgeschlagen: {activeJob.error}</span>
          <button className="btn" disabled={retryPending || running} onClick={() => onRetry(activeJob.job_id)}>
            {retryPending ? "Starte…" : "Erneut versuchen"}
          </button>
        </div>
      )}

      {activeJob?.status === "failed" && activeJob.phase === "asr" && hasTranscript && (
        <div className="detail-error detail-error-box detail-error-row">
          <span>Transkription fehlgeschlagen: {activeJob.error}</span>
          <button className="btn" disabled={transcribePending || running} onClick={onRetranscribe}>
            {transcribePending ? "Starte…" : "Nochmal transkribieren"}
          </button>
        </div>
      )}
    </>
  );
}
