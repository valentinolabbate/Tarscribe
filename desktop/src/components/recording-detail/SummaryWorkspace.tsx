import type { RefObject } from "react";
import {
  useExtractActionItems,
  useRecordingActionItems,
  useRecordingJobs,
} from "../../hooks/queries";
import { useJobFor } from "../../hooks/useJobs";
import { SummaryPanel } from "../SummaryPanel";
import type { PlayerHandle } from "../AudioPlayer";
import { RefreshIcon, SummaryIcon, TasksIcon } from "../icons";
import { summaryTaskState } from "./summaryTaskStatus";

export function SummaryWorkspace({
  recordingId,
  recordingTitle,
  onOpenSettings,
  playerRef,
  onOpenRecording,
  onOpenDocument,
  onOpenTimeline,
}: {
  recordingId: number;
  recordingTitle: string;
  onOpenSettings?: () => void;
  playerRef: RefObject<PlayerHandle | null>;
  onOpenRecording?: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
  onOpenTimeline: () => void;
}) {
  const { data: actionItems, isLoading: actionItemsLoading } =
    useRecordingActionItems(recordingId);
  const { data: jobs, isLoading: jobsLoading } = useRecordingJobs(recordingId);
  const extract = useExtractActionItems(recordingId);
  const liveJob = useJobFor(recordingId);
  const persistedActionJob = jobs?.find((job) => job.phase === "action_items");
  const actionJob = liveJob?.phase === "action_items" ? liveJob : persistedActionJob;
  const itemCount = actionItems?.filter((item) => item.review_state !== "rejected").length ?? 0;
  const taskState = extract.isError
    ? "failed"
    : summaryTaskState({
        itemCount,
        job: actionJob,
        extractionPending: extract.isPending,
        loading: actionItemsLoading || jobsLoading,
      });

  const taskStatus = {
    loading: {
      title: "Aufgabenstatus wird geprüft",
      detail: "Einen Moment bitte.",
    },
    extracting: {
      title: itemCount > 0 ? "Aufgaben werden aktualisiert" : "Aufgaben werden extrahiert",
      detail:
        itemCount > 0
          ? `${itemCount} bestehende ${itemCount === 1 ? "Eintrag bleibt" : "Einträge bleiben"} sichtbar.`
          : "Erkannte Einträge erscheinen anschließend im Zeitstrahl.",
    },
    extracted: {
      title: "Aufgaben extrahiert",
      detail: `${itemCount} ${itemCount === 1 ? "Eintrag" : "Einträge"} im Zeitstrahl`,
    },
    empty: {
      title: "Aufgaben extrahiert",
      detail: "Keine Aufgaben oder Zusagen erkannt.",
    },
    failed: {
      title: "Extraktion nicht abgeschlossen",
      detail:
        (extract.error instanceof Error ? extract.error.message : actionJob?.error) ||
        "Die Analyse kann erneut gestartet werden.",
    },
    missing: {
      title: "Aufgaben noch nicht extrahiert",
      detail: "Die Analyse kann hier einmalig gestartet werden.",
    },
  }[taskState];

  const handleOpenSource = (sourceRecordingId: number, startSec?: number | null) => {
    if (sourceRecordingId === recordingId) {
      playerRef.current?.seek(startSec ?? 0);
    } else {
      onOpenRecording?.(sourceRecordingId, startSec);
    }
  };

  return (
    <section className="detail-panel summary-workspace">
      <div className="detail-panel-head">
        <div>
          <h2>Auswertung</h2>
          <p>Aufgaben bleiben im Zeitstrahl; hier entsteht die kompakte Zusammenfassung.</p>
        </div>
        <SummaryIcon width={20} height={20} />
      </div>
      <div className={`summary-task-status ${taskState}`} aria-live="polite">
        <span className="summary-task-status-icon" aria-hidden="true">
          {taskState === "loading" || taskState === "extracting" ? (
            <RefreshIcon width={16} height={16} />
          ) : (
            <TasksIcon width={16} height={16} />
          )}
        </span>
        <div className="summary-task-status-copy">
          <span>Aufgabenanalyse</span>
          <strong>{taskStatus.title}</strong>
          <small>{taskStatus.detail}</small>
        </div>
        {(taskState === "extracted" || taskState === "empty") && (
          <button type="button" className="summary-task-status-action" onClick={onOpenTimeline}>
            Zeitstrahl öffnen
          </button>
        )}
        {(taskState === "missing" || taskState === "failed") && (
          <button
            type="button"
            className="btn"
            disabled={extract.isPending}
            onClick={() => extract.mutate(undefined)}
          >
            {taskState === "failed" ? "Erneut versuchen" : "Aufgaben extrahieren"}
          </button>
        )}
      </div>
      <SummaryPanel
        recordingId={recordingId}
        recordingTitle={recordingTitle}
        onOpenSettings={onOpenSettings}
        onOpenSource={handleOpenSource}
        onOpenDocument={onOpenDocument}
      />
    </section>
  );
}
