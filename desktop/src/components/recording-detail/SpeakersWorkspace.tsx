import { useMemo, useState, type RefObject } from "react";
import { useEnrollSpeaker, useSpeakerEdits } from "../../hooks/queries";
import type { DiarizationData } from "../../lib/types";
import type { PlayerHandle } from "../AudioPlayer";
import { SpeakerStatsPanel } from "../SpeakerStatsPanel";
import { TuningPanel } from "../TuningPanel";
import { SpeakerIdIcon } from "../icons";
import { colorFor } from "./model";
import { findSpeakerPreview, type SpeakerPreviewRange } from "./speakerPreview";

function SpeakerLegend({
  recordingId,
  diar,
  labels,
  playerRef,
  currentTime,
  playing,
}: {
  recordingId: number;
  diar: DiarizationData;
  labels: string[];
  playerRef: RefObject<PlayerHandle | null>;
  currentTime: number;
  playing: boolean;
}) {
  const { rename, merge, reset } = useSpeakerEdits(recordingId);
  const enroll = useEnrollSpeaker(recordingId);
  const [activePreview, setActivePreview] = useState<
    (SpeakerPreviewRange & { speaker: string }) | null
  >(null);
  const previews = useMemo(
    () =>
      new Map(
        diar.speakers.map((speaker) => [
          speaker.label,
          findSpeakerPreview(diar.segments, speaker.label),
        ]),
      ),
    [diar.segments, diar.speakers],
  );

  function saveVoice(label: string, currentName: string) {
    const isRaw = /^SPEAKER_\d+$/.test(currentName);
    const name = isRaw ? window.prompt("Name für diese Stimme:", "")?.trim() : currentName;
    if (name) enroll.mutate({ label, name });
  }

  async function togglePreview(speaker: string, preview: SpeakerPreviewRange) {
    const isActive =
      activePreview?.speaker === speaker &&
      playing &&
      currentTime >= preview.start &&
      currentTime < preview.end;
    if (isActive) {
      playerRef.current?.playPause();
      return;
    }
    setActivePreview({ speaker, ...preview });
    await playerRef.current?.playRange(preview.start, preview.end);
  }

  return (
    <div className="legend">
      {diar.speakers.map((speaker) => {
        const preview = previews.get(speaker.label);
        const previewPlaying =
          !!preview &&
          activePreview?.speaker === speaker.label &&
          playing &&
          currentTime >= preview.start &&
          currentTime < preview.end;
        return (
          <div
            className={`legend-item${previewPlaying ? " preview-playing" : ""}`}
            key={speaker.label}
          >
            <span className="topic-dot" style={{ background: colorFor(speaker.label, labels) }} />
            <input
              className="legend-name"
              defaultValue={speaker.name}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value && value !== speaker.name) {
                  rename.mutate({ label: speaker.label, name: value });
                }
              }}
              onKeyDown={(event) =>
                event.key === "Enter" && (event.target as HTMLInputElement).blur()
              }
            />
            <button
              className="speaker-preview-btn"
              type="button"
              disabled={!preview}
              title={
                preview
                  ? previewPlaying
                    ? "Stimmprobe pausieren"
                    : "Ununterbrochene Stimmprobe abspielen"
                  : "Kein ausreichend langer Solo-Abschnitt verfügbar"
              }
              aria-label={
                previewPlaying
                  ? `${speaker.name} pausieren`
                  : `Stimmprobe von ${speaker.name} abspielen`
              }
              onClick={() => preview && void togglePreview(speaker.label, preview)}
            >
              {previewPlaying ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6.5" y="5" width="4" height="14" rx="1" />
                  <rect x="13.5" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 5.8v12.4a1 1 0 0 0 1.53.85l9.3-6.2a1 1 0 0 0 0-1.7l-9.3-6.2A1 1 0 0 0 8 5.8Z" />
                </svg>
              )}
            </button>
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
                  if (event.target.value) {
                    merge.mutate({ from: speaker.label, to: event.target.value });
                  }
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
        );
      })}
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
  playerRef,
  currentTime,
  playing,
}: {
  recordingId: number;
  diar?: DiarizationData;
  labels: string[];
  showTuning: boolean;
  running: boolean;
  diarizePending: boolean;
  onToggleTuning: () => void;
  onDiarize: () => void;
  playerRef: RefObject<PlayerHandle | null>;
  currentTime: number;
  playing: boolean;
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
          <SpeakerLegend
            recordingId={recordingId}
            diar={diar}
            labels={labels}
            playerRef={playerRef}
            currentTime={currentTime}
            playing={playing}
          />
          {showTuning && (
            <TuningPanel recordingId={recordingId} initial={diar.params} disabled={running} />
          )}
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
            <p>
              Starte die Erkennung, wenn diese Aufnahme mehrere Stimmen enthält oder du bekannte
              Stimmen speichern willst.
            </p>
          </div>
          <button className="btn primary" disabled={diarizePending || running} onClick={onDiarize}>
            Sprecher erkennen
          </button>
        </div>
      )}
    </section>
  );
}
