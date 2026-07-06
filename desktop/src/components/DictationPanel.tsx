import type { DictationController } from "../hooks/useDictation";
import { MicIcon, StopIcon, TrashIcon } from "./icons";

export function DictationPanel({
  dictation,
  shortcutLabel,
}: {
  dictation: DictationController;
  shortcutLabel: string;
}) {
  const active = dictation.state !== "idle";

  return (
    <section className={`start-card dictation-panel ${active ? "active" : ""}`} aria-label="Diktat-Inbox">
      <div className="start-card-head">
        <div>
          <h3>Diktat</h3>
          <p>Gedanke festhalten</p>
        </div>
      </div>
      <div className="dictation-control">
        <div className="dictation-live">
          <div className="dictation-meter" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="dictation-time">{dictation.elapsedLabel}</div>
        </div>
        <div className="dictation-buttons">
          {dictation.state === "recording" && (
            <button className="btn ghost" onClick={dictation.discard} title="Diktat verwerfen">
              <TrashIcon width={15} height={15} />
              Verwerfen
            </button>
          )}
          <button
            className={dictation.state === "recording" ? "btn danger dictation-main" : "btn primary dictation-main"}
            disabled={dictation.state === "starting" || dictation.state === "saving"}
            onClick={dictation.state === "recording" ? dictation.stopAndSave : dictation.start}
          >
            {dictation.state === "recording" ? <StopIcon width={16} height={16} /> : <MicIcon width={16} height={16} />}
            {dictation.state === "starting"
              ? "Startet..."
              : dictation.state === "saving"
                ? "Speichert..."
                : dictation.state === "recording"
                  ? "Stopp & speichern"
                  : "Diktat starten"}
          </button>
        </div>
      </div>
      <span className="dictation-shortcut" title="Startet oder speichert das Diktat">{shortcutLabel}</span>
    </section>
  );
}
