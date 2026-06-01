import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { installUpdate, type PendingUpdate } from "../lib/updater";
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

  async function install() {
    setInstalling(true);
    try {
      await installUpdate(pending, setProgress);
      // App relaunches; this line is usually not reached.
    } catch (e) {
      toast(`Update fehlgeschlagen: ${(e as Error).message}`, "error");
      setInstalling(false);
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
          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>
              Später
            </button>
            <button className="btn primary" onClick={install}>
              Jetzt installieren & neu starten
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
