import { WaveIcon } from "../icons";

export function DetailEmptyState({
  running,
  startingPhase,
  transcribePending,
  error,
  onTranscribe,
}: {
  running: boolean;
  startingPhase: string | null;
  transcribePending: boolean;
  error?: string | null;
  onTranscribe: () => void;
}) {
  if (running || startingPhase) return null;
  return (
    <div className="detail-empty-state">
      <div className="rec-icon">
        <WaveIcon />
      </div>
      <div>
        <h2>{error ? "Transkription fehlgeschlagen" : "Bereit zum Transkribieren"}</h2>
        <p>Erstelle zuerst ein Transkript. Danach erscheinen Zusammenfassung, Fragen und Sprecherbereiche als eigene Tabs.</p>
      </div>
      <button className="btn primary" disabled={transcribePending} onClick={onTranscribe}>
        {error ? "Erneut transkribieren" : "Jetzt transkribieren"}
      </button>
      {error && <div className="detail-error">{error}</div>}
    </div>
  );
}
