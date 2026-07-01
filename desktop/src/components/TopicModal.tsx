import { type FormEvent, useState } from "react";
import { useCreateTopic } from "../hooks/queries";
import { validateRequired } from "../lib/formValidation";

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4"];

export function TopicModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [color, setColor] = useState(COLORS[0]);
  const create = useCreateTopic();
  const nameError = validateRequired(name, "Name");

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setNameTouched(true);
    if (nameError) return;
    await create.mutateAsync({ name: name.trim(), color });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Neuer Themenbereich</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label>Name</label>
            <input
              type="text"
              autoFocus
              placeholder="z. B. Uni, Arbeit, Interviews"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              aria-invalid={nameTouched && !!nameError}
              aria-describedby={nameTouched && nameError ? "topic-name-error" : undefined}
            />
            {nameTouched && nameError && (
              <div id="topic-name-error" className="field-error">
                {nameError}
              </div>
            )}
          </div>
          <div className="field">
            <label>Farbe</label>
            <div className="swatches">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${c === color ? "sel" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" type="button" onClick={onClose}>
              Abbrechen
            </button>
            <button className="btn primary" type="submit" disabled={!!nameError || create.isPending}>
              Erstellen
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
