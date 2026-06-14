import type { DictationController } from "../hooks/useDictation";
import { MicIcon, StopIcon, TrashIcon } from "./icons";

export function DictationOverlay({ dictation }: { dictation: DictationController }) {
  if (dictation.state === "idle") return null;
  const saving = dictation.state === "saving";
  const starting = dictation.state === "starting";

  return (
    <div className="dictation-overlay" role="status" aria-live="polite">
      <div className="dictation-overlay-icon">
        <MicIcon width={16} height={16} />
      </div>
      <div className="dictation-overlay-copy">
        <strong>{saving ? "Diktat wird gespeichert" : starting ? "Diktat startet" : "Diktat läuft"}</strong>
        <span>{dictation.elapsedLabel}</span>
      </div>
      {dictation.state === "recording" && (
        <button className="btn ghost" onClick={dictation.discard} title="Diktat verwerfen">
          <TrashIcon width={14} height={14} />
        </button>
      )}
      <button
        className="btn danger"
        disabled={starting || saving}
        onClick={dictation.stopAndSave}
      >
        <StopIcon width={15} height={15} />
        Speichern
      </button>
    </div>
  );
}
