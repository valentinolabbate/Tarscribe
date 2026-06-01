import { useState } from "react";
import { useUpdateTopic } from "../hooks/queries";
import { isTauri, pickFolder } from "../lib/tauri";
import type { Topic } from "../lib/types";

export function TopicExportModal({ topic, onClose }: { topic: Topic; onClose: () => void }) {
  const update = useUpdateTopic();
  const [path, setPath] = useState(topic.export_path ?? "");

  async function browse() {
    const dir = await pickFolder();
    if (dir) setPath(dir);
  }

  async function save() {
    await update.mutateAsync({ id: topic.id, patch: { export_path: path.trim() } });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <h2>Export-Ordner für „{topic.name}"</h2>
        <p className="rec-sub" style={{ marginTop: -6, marginBottom: 12 }}>
          Markdown-Notizen aus diesem Bereich werden hierhin gesendet — z. B. in einen
          Obsidian-Vault-Ordner.
        </p>
        <div className="field">
          <label>Ordnerpfad</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder="/Users/du/Obsidian/Uni"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              style={{ flex: 1 }}
              spellCheck={false}
            />
            {isTauri() && (
              <button className="btn" onClick={browse}>
                Durchsuchen…
              </button>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save} disabled={update.isPending}>
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}
