import { useRef, useState } from "react";
import { useDeleteRecording, useLatestJob, useRecordings, useUploadRecording } from "../hooks/queries";
import { preferJobEvent, useJobFor } from "../hooks/useJobs";
import { useUndoableDelete } from "../hooks/useUndoableDelete";
import { fmtDate, fmtDuration, jobPhaseLabel, statusLabel } from "../lib/format";
import type { Recording, Topic } from "../lib/types";
import { DocumentsPanel } from "./DocumentsPanel";
import { RecordControl } from "./RecordControl";
import { MoreIcon, SearchIcon, TrashIcon, UploadIcon, WaveIcon } from "./icons";

function RecordingRow({
  r,
  onOpen,
  onDelete,
}: {
  r: Recording;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const liveJob = useJobFor(r.id);
  const localRunning = liveJob?.status === "running" || liveJob?.status === "pending";
  const statusRunning = r.status === "queued" || r.status === "transcribing" || r.status === "diarizing";
  const { data: polledJob } = useLatestJob(r.id, localRunning || statusRunning);
  const job = preferJobEvent(liveJob, polledJob);
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
      <details className="rec-actions" onClick={(event) => event.stopPropagation()}>
        <summary title="Aufnahme verwalten" aria-label={`${r.title} verwalten`}>
          <MoreIcon width={17} height={17} />
        </summary>
        <div className="rec-menu">
          <button className="danger" type="button" onClick={onDelete}>
            <TrashIcon width={15} height={15} /> Löschen
          </button>
        </div>
      </details>
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
  const undoDelete = useUndoableDelete();
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"recordings" | "documents">("recordings");

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      await upload.mutateAsync({ topicId: topic.id, file });
    }
  }

  const recordingCount = recordings?.length ?? 0;
  const hasRecordings = recordingCount > 0;
  const visibleRecordings = recordings?.filter(
    (recording) =>
      !undoDelete.isPending(recording.id) &&
      recording.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ) ?? [];
  const totalDuration = recordings?.reduce((sum, recording) => sum + recording.duration_sec, 0) ?? 0;

  return (
    <div
      className="recordings-page"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
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
        onChange={async (e) => {
          const input = e.currentTarget;
          await handleFiles(input.files);
          input.value = "";
        }}
      />

      <header className="library-head">
        <div>
          <h2>{topic.name}</h2>
          <p>
            {recordingCount} {recordingCount === 1 ? "Aufnahme" : "Aufnahmen"}
            {recordingCount > 0 && <span>·</span>}
            {recordingCount > 0 && <span>{fmtDuration(totalDuration)}</span>}
          </p>
        </div>
        <div className="library-actions">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            <UploadIcon /> Importieren
          </button>
          <RecordControl topicId={topic.id} topicName={topic.name} primary />
        </div>
      </header>

      <nav className="library-tabs" aria-label="Inhalte des Themenbereichs">
        <button className={activeTab === "recordings" ? "active" : ""} onClick={() => setActiveTab("recordings")}>
          Aufnahmen
          {recordingCount > 0 && <span>{recordingCount}</span>}
        </button>
        <button className={activeTab === "documents" ? "active" : ""} onClick={() => setActiveTab("documents")}>
          Dokumente
        </button>
      </nav>

      {activeTab === "recordings" && (isLoading ? (
        <div className="empty">Lade…</div>
      ) : hasRecordings ? (
        <>
          <div className="library-tools">
            <label className="search-field">
              <SearchIcon width={16} height={16} />
              <input
                type="search"
                placeholder="Aufnahmen durchsuchen"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span className="library-hint">Audio und Video hierher ziehen</span>
          </div>

          <div className={`rec-list ${dragOver ? "drag-active" : ""}`}>
            {visibleRecordings.map((r) => (
              <RecordingRow
                key={r.id}
                r={r}
                onOpen={() => onOpen(r)}
                onDelete={() =>
                  undoDelete.schedule(r.id, () => del.mutate(r.id), `„${r.title}" gelöscht`)
                }
              />
            ))}
            {visibleRecordings.length === 0 && (
              <div className="list-empty empty-next">
                <strong>Keine Aufnahme passt zu deiner Suche.</strong>
                <span>Setze den Suchfilter zurück oder importiere eine neue Aufnahme in diesen Bereich.</span>
                <button className="btn ghost" onClick={() => setQuery("")}>
                  Suche zurücksetzen
                </button>
              </div>
            )}
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
        </>
      ) : (
        <div className={`drop-hint ${dragOver ? "over" : ""}`}>
          <div className="drop-icon"><WaveIcon /></div>
          <h2>Audio hier ablegen</h2>
          <p>Oder oben eine Aufnahme starten beziehungsweise eine Datei importieren.</p>
        </div>
      ))}

      {activeTab === "documents" && <DocumentsPanel topicId={topic.id} />}
    </div>
  );
}
