import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { describeError, installUpdate, openReleasesPage, type PendingUpdate } from "../lib/updater";
import { useToast } from "./Toast";

export function UpdateModal({
  pending,
  onClose,
}: {
  pending: PendingUpdate;
  onClose: () => void;
}) {
  const toast = useToast();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function install() {
    setInstalling(true);
    setError(null);
    try {
      const result = await installUpdate(pending, setProgress);
      // "relaunching": the app restarts, so this line is usually not reached.
      if (result === "needs-restart") {
        toast("Update installiert. Bitte beende Tarscribe und öffne es neu.", "success");
        onClose();
      }
    } catch (e) {
      setError(describeError(e));
      setInstalling(false);
    }
  }

  async function downloadManually() {
    try {
      await openReleasesPage();
    } catch (e) {
      toast(`Konnte die Download-Seite nicht öffnen: ${describeError(e)}`, "error");
    }
  }

  return (
    <div className="modal-backdrop" onClick={installing ? undefined : onClose}>
      <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h2>Update verfügbar</h2>
        <p className="rec-sub" style={{ marginTop: -6 }}>
          Version {pending.info.version} ist bereit zur Installation.
        </p>
        {pending.info.notes && (
          <div className="markdown update-notes">
            <ReactMarkdown>{pending.info.notes}</ReactMarkdown>
          </div>
        )}

        {installing ? (
          <div style={{ marginTop: 14 }}>
            <div className="rec-sub" style={{ marginBottom: 6 }}>
              Lädt… {Math.round(progress * 100)}%
            </div>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        ) : (
          <>
            {error && (
              <div className="detail-error" style={{ marginTop: 12 }}>
                Update fehlgeschlagen: {error}
                <br />
                Du kannst die neue Version stattdessen manuell herunterladen.
              </div>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Später
              </button>
              {error && (
                <button className="btn" onClick={downloadManually}>
                  Manuell herunterladen
                </button>
              )}
              <button className="btn primary" onClick={install}>
                {error ? "Erneut versuchen" : "Jetzt installieren & neu starten"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
