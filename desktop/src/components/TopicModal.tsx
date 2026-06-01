import { useState } from "react";
import { useCreateTopic } from "../hooks/queries";

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4"];

export function TopicModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const create = useCreateTopic();

  async function submit() {
    if (!name.trim()) return;
    await create.mutateAsync({ name: name.trim(), color });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Neuer Themenbereich</h2>
        <div className="field">
          <label>Name</label>
          <input
            type="text"
            autoFocus
            placeholder="z. B. Uni, Arbeit, Interviews"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div className="field">
          <label>Farbe</label>
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${c === color ? "sel" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={submit} disabled={!name.trim() || create.isPending}>
            Erstellen
          </button>
        </div>
      </div>
    </div>
  );
}
