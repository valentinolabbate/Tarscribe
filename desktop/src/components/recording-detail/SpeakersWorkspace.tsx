import { useEnrollSpeaker, useSpeakerEdits } from "../../hooks/queries";
import type { DiarizationData } from "../../lib/types";
import { SpeakerStatsPanel } from "../SpeakerStatsPanel";
import { TuningPanel } from "../TuningPanel";
import { SpeakerIdIcon } from "../icons";
import { colorFor } from "./model";

function SpeakerLegend({
  recordingId,
  diar,
  labels,
}: {
  recordingId: number;
  diar: DiarizationData;
  labels: string[];
}) {
  const { rename, merge, reset } = useSpeakerEdits(recordingId);
  const enroll = useEnrollSpeaker(recordingId);

  function saveVoice(label: string, currentName: string) {
    const isRaw = /^SPEAKER_\d+$/.test(currentName);
    const name = isRaw ? window.prompt("Name für diese Stimme:", "")?.trim() : currentName;
    if (name) enroll.mutate({ label, name });
  }

  return (
    <div className="legend">
      {diar.speakers.map((speaker) => (
        <div className="legend-item" key={speaker.label}>
          <span className="topic-dot" style={{ background: colorFor(speaker.label, labels) }} />
          <input
            className="legend-name"
            defaultValue={speaker.name}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value && value !== speaker.name) rename.mutate({ label: speaker.label, name: value });
            }}
            onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
          />
          <button
            className="btn ghost"
            style={{ padding: 5 }}
            title="Stimme als bekannten Sprecher speichern"
            disabled={enroll.isPending}
            onClick={() => saveVoice(speaker.label, speaker.name)}
          >
            <SpeakerIdIcon width={16} height={16} />
          </button>
          {diar.speakers.length > 1 && (
            <select
              className="merge-sel"
              value=""
              onChange={(event) => {
                if (event.target.value) merge.mutate({ from: speaker.label, to: event.target.value });
              }}
              title="Mit anderem Sprecher zusammenführen"
            >
              <option value="">zusammenführen...</option>
              {diar.speakers
                .filter((other) => other.label !== speaker.label)
                .map((other) => (
                  <option key={other.label} value={other.label}>
                    → {other.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <button className="btn ghost" onClick={() => reset.mutate()} title="Alle Korrekturen zurücksetzen">
        Zurücksetzen
      </button>
    </div>
  );
}

export function SpeakersWorkspace({
  recordingId,
  diar,
  labels,
  showTuning,
  running,
  diarizePending,
  onToggleTuning,
  onDiarize,
}: {
  recordingId: number;
  diar?: DiarizationData;
  labels: string[];
  showTuning: boolean;
  running: boolean;
  diarizePending: boolean;
  onToggleTuning: () => void;
  onDiarize: () => void;
}) {
  return (
    <section className="detail-panel speakers-workspace">
      <div className="detail-panel-head">
        <div>
          <h2>Sprecher</h2>
          <p>Namen korrigieren, Stimmen speichern und die Diarisierung feinjustieren.</p>
        </div>
        {diar && (
          <button className={showTuning ? "btn active" : "btn"} onClick={onToggleTuning}>
            Tuning
          </button>
        )}
      </div>

      {diar ? (
        <>
          <SpeakerLegend recordingId={recordingId} diar={diar} labels={labels} />
          {showTuning && <TuningPanel recordingId={recordingId} initial={diar.params} disabled={running} />}
          <SpeakerStatsPanel
            recordingId={recordingId}
            labels={labels}
            colorFor={(label) => colorFor(label, labels)}
          />
          <div className="speaker-note">
            Sprecherzuweisung einzelner Textstellen änderst du direkt im Tab „Transkript".
          </div>
        </>
      ) : (
        <div className="speaker-empty">
          <div className="rec-icon">
            <SpeakerIdIcon />
          </div>
          <div>
            <h3>Noch keine Sprechererkennung</h3>
            <p>Starte die Erkennung, wenn diese Aufnahme mehrere Stimmen enthält oder du bekannte Stimmen speichern willst.</p>
          </div>
          <button className="btn primary" disabled={diarizePending || running} onClick={onDiarize}>
            Sprecher erkennen
          </button>
        </div>
      )}
    </section>
  );
}
