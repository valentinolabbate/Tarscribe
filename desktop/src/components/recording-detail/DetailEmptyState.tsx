import { WaveIcon } from "../icons";

export function DetailEmptyState({
  loading,
  onOpenProcessing,
}: {
  loading: boolean;
  onOpenProcessing: () => void;
}) {
  return (
    <div className="detail-empty-state">
      <div className="rec-icon">
        <WaveIcon />
      </div>
      <div>
        <h2>{loading ? "Transkript wird geladen…" : "Noch kein Transkript"}</h2>
        <p>{loading ? "Die Aufnahme wird vorbereitet."
          : "Öffne die Verarbeitung, um das Audio zu prüfen und die Transkription zu starten."}</p>
      </div>
      {!loading && <button className="btn primary" onClick={onOpenProcessing}>Zur Verarbeitung</button>}
    </div>
  );
}
