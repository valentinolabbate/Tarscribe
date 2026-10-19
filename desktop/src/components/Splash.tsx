import { BackendStatus } from "./BackendStatus";
import type { BackendConnection } from "../lib/backendMonitor";

export function Splash({ connection, onRestart }: { connection: BackendConnection; onRestart: () => void }) {
  return (
    <div className="splash">
      {connection.status === "offline" || connection.status === "restarting" ? (
        <BackendStatus connection={connection} onRestart={onRestart} />
      ) : (
        <>
          <div className="spinner" />
          <div>Tarscribe wird gestartet…</div>
        </>
      )}
    </div>
  );
}
