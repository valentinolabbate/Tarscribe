import { useRef, useState } from "react";
import { useDeleteRecording, useRecordings, useUploadRecording } from "../hooks/queries";
import { useJobFor } from "../hooks/useJobs";
import { fmtDate, fmtDuration, jobPhaseLabel, statusLabel } from "../lib/format";
import type { Recording, Topic } from "../lib/types";
import { RecordControl } from "./RecordControl";
import { TrashIcon, UploadIcon, WaveIcon } from "./icons";

function RecordingRow({
  r,
  onOpen,
  onDelete,
}: {
  r: Recording;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const job = useJobFor(r.id);
  const statusRunning = r.status === "transcribing" || r.status === "diarizing";
  const running = !!(job && (job.status === "running" || job.status === "pending")) || statusRunning;
  const pct = Math.round((job?.progress ?? 0) * 100);
  const phaseLabel = job
    ? jobPhaseLabel(job.phase)
    : r.status === "diarizing"
      ? jobPhaseLabel("diarization")
      : jobPhaseLabel("asr");
  return (
    <div className="rec-card" onClick={onOpen} style={{ cursor: "pointer" }}>
      <div className="rec-icon">
        <WaveIcon />
      </div>
      <div className="rec-meta">
        <div className="rec-title">{r.title}</div>
        <div className="rec-sub">
          {fmtDuration(r.duration_sec)} · {fmtDate(r.created_at)}
        </div>
        {running && (
          <div className="progress" style={{ marginTop: 8 }}>
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <span className={`badge ${running ? "transcribing" : r.status}`}>
        {running ? `${phaseLabel}… ${pct}%` : statusLabel(r.status)}
      </span>
      <button
        className="btn ghost danger"
        title="Löschen"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

export function RecordingList({
  topic,
  onOpen,
}: {
  topic: Topic;
  onOpen: (r: Recording) => void;
}) {
  const { data: recordings, isLoading } = useRecordings(topic.id);
  const upload = useUploadRecording();
  const del = useDeleteRecording(topic.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      await upload.mutateAsync({ topicId: topic.id, file });
    }
  }

  const hasRecordings = recordings && recordings.length > 0;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,video/*,.m4a,.mp3,.wav,.mp4,.aac,.ogg,.flac"
        multiple
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />

      {isLoading ? (
        <div className="empty">Lade…</div>
      ) : hasRecordings ? (
        <div className="rec-list">
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 2 }}>
            <RecordControl topicId={topic.id} topicName={topic.name} />
            <button className="btn" onClick={() => fileInput.current?.click()}>
              <UploadIcon /> Hochladen
            </button>
          </div>
          {recordings!.map((r) => (
            <RecordingRow
              key={r.id}
              r={r}
              onOpen={() => onOpen(r)}
              onDelete={() => del.mutate(r.id)}
            />
          ))}
          {upload.isPending && (
            <div className="rec-card" style={{ opacity: 0.6 }}>
              <div className="rec-icon">
                <WaveIcon />
              </div>
              <div className="rec-meta">
                <div className="rec-title">Wird verarbeitet…</div>
                <div className="rec-sub">Audio wird normalisiert</div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className={`drop-hint ${dragOver ? "over" : ""}`}>
          <div style={{ marginBottom: 8 }}>
            Noch keine Aufnahmen in <strong>{topic.name}</strong>.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <RecordControl topicId={topic.id} topicName={topic.name} />
            <button className="btn primary" onClick={() => fileInput.current?.click()}>
              <UploadIcon /> Hochladen
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12 }}>oder Dateien hierher ziehen</div>
        </div>
      )}
    </div>
  );
}
