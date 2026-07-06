import { fmtDuration, statusLabel } from "../../lib/format";
import type { DiarizationData, Recording, Topic, TranscriptData } from "../../lib/types";
import { FolderIcon, MoreIcon, SpeakerIdIcon } from "../icons";

export function RecordingToolbar({
  recording,
  topics,
  transcript,
  diar,
  isTranscribed,
  updatePending,
  diarizePending,
  running,
  transcribePending,
  exportOpen,
  onBack,
  onRename,
  onMoveRecording,
  onDetectSpeakers,
  onRetranscribe,
  onToggleExport,
  onCloseExport,
  onExport,
  onDownloadAudio,
  onSendToFolder,
}: {
  recording: Recording;
  topics: Topic[];
  transcript?: TranscriptData;
  diar?: DiarizationData;
  isTranscribed: boolean;
  updatePending: boolean;
  diarizePending: boolean;
  running: boolean;
  transcribePending: boolean;
  exportOpen: boolean;
  onBack: () => void;
  onRename: (title: string) => void;
  onMoveRecording: (topicId: number) => void;
  onDetectSpeakers: () => void;
  onRetranscribe: () => void;
  onToggleExport: () => void;
  onCloseExport: () => void;
  onExport: (format: string) => void;
  onDownloadAudio: () => void;
  onSendToFolder: () => void;
}) {
  return (
    <header className="detail-hero">
      <button className="btn ghost detail-back" onClick={onBack}>
        ← Aufnahmen
      </button>
      <div className="detail-title-block">
        <input
          className="detail-title-input"
          defaultValue={recording.title}
          key={recording.id}
          onBlur={(event) => {
            const title = event.target.value.trim();
            if (title && title !== recording.title) onRename(title);
          }}
          onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
          title="Zum Umbenennen klicken"
        />
        <div className="detail-meta">
          <span>{fmtDuration(recording.duration_sec)}</span>
          <span>{statusLabel(recording.status)}</span>
          {transcript && <span>{transcript.asr_model}</span>}
          {diar && <span>{diar.speakers.length} Sprecher</span>}
        </div>
      </div>

      <div className="detail-actions">
        <div className="export-wrap">
          <button
            className="btn ghost detail-more"
            onClick={onToggleExport}
            title="Weitere Aktionen"
            aria-label="Weitere Aktionen"
          >
            <MoreIcon width={18} height={18} />
          </button>
          {exportOpen && (
            <div className="export-menu recording-actions-menu" onMouseLeave={onCloseExport}>
              {topics.length > 1 && (
                <label className="recording-topic-select" title="Aufnahme verschieben">
                  <FolderIcon width={16} height={16} />
                  <select
                    value={recording.topic_id}
                    disabled={updatePending}
                    onChange={(event) => onMoveRecording(Number(event.target.value))}
                    aria-label="Aufnahme verschieben"
                  >
                    {topics.map((topic) => (
                      <option key={topic.id} value={topic.id}>{topic.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {isTranscribed && transcript && !diar && (
                <button disabled={diarizePending || running} onClick={onDetectSpeakers}>
                  <SpeakerIdIcon width={15} height={15} /> Sprecher erkennen
                </button>
              )}
              {transcript && (
                <button disabled={transcribePending || running} onClick={onRetranscribe}>
                  Neu transkribieren
                </button>
              )}
              {isTranscribed && transcript && (
                <>
                  <div className="menu-divider" />
                {["txt", "srt", "vtt", "json"].map((format) => (
                  <button key={format} onClick={() => onExport(format)}>
                    .{format.toUpperCase()}
                  </button>
                ))}
                <button onClick={onDownloadAudio}>Audio (WAV)</button>
                <button className="export-folder-item" onClick={onSendToFolder}>
                  An Ordner senden
                </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
