import type { BackendConnection } from "../lib/backendMonitor";
import { isTauri } from "../lib/tauri";

export function BackendStatus({ connection, onRestart }: {
  connection: BackendConnection;
  onRestart: () => void;
}) {
  if (connection.status === "online") return null;
  const desktop = isTauri();
  const busy = connection.status === "starting" || connection.status === "restarting";
  return (
    <div className="backend-status" role={busy ? "status" : "alert"}>
      <div>
        <strong>{busy ? desktop ? "Tarscribe-Dienst wird gestartet…" : "Verbindung wird geprüft…" : "Tarscribe-Dienst nicht erreichbar"}</strong>
        <p>{busy ? "Die Verbindung wird automatisch wiederhergestellt." : "Aufnahmen und Verarbeitung sind derzeit eingeschränkt. Sobald der Dienst wieder antwortet, werden die Daten automatisch aktualisiert."}</p>
        {connection.error && <p className="backend-status-error">{connection.error}</p>}
      </div>
      <button className="btn primary" onClick={onRestart} disabled={busy}>
        {busy ? "Bitte warten…" : desktop ? "Dienst neu starten" : "Erneut verbinden"}
      </button>
    </div>
  );
}
