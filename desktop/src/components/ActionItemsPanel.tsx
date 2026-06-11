import {
  useDeleteActionItem,
  useExtractActionItems,
  useRecordingActionItems,
  useUpdateActionItem,
} from "../hooks/queries";
import { useJobFor } from "../hooks/useJobs";
import type { ActionItem } from "../lib/types";
import { TasksIcon, TrashIcon } from "./icons";

export function ActionItemRow({
  item,
  showRecording = false,
  onOpenRecording,
}: {
  item: ActionItem;
  showRecording?: boolean;
  onOpenRecording?: (recordingId: number) => void;
}) {
  const update = useUpdateActionItem();
  const del = useDeleteActionItem();
  return (
    <div className={`action-item ${item.done ? "done" : ""}`}>
      <input
        type="checkbox"
        checked={item.done}
        onChange={(e) => update.mutate({ id: item.id, patch: { done: e.target.checked } })}
        title={item.done ? "Als offen markieren" : "Als erledigt markieren"}
      />
      <div className="action-item-body">
        <span className="action-item-text">{item.text}</span>
        <span className="action-item-meta">
          <span className={`action-kind ${item.kind}`}>
            {item.kind === "decision" ? "Entscheidung" : "Aufgabe"}
          </span>
          {item.assignee && <span>{item.assignee}</span>}
          {item.due && <span>bis {item.due}</span>}
          {showRecording && item.recording_title && (
            <button
              className="action-item-rec"
              onClick={() => onOpenRecording?.(item.recording_id)}
              title="Aufnahme öffnen"
            >
              {item.recording_title}
            </button>
          )}
        </span>
      </div>
      <button
        className="topic-del"
        title="Eintrag löschen"
        onClick={() => del.mutate(item.id)}
      >
        <TrashIcon width={13} height={13} />
      </button>
    </div>
  );
}

/** Per-recording action items: extraction trigger + checkable list. */
export function ActionItemsPanel({ recordingId }: { recordingId: number }) {
  const { data: items } = useRecordingActionItems(recordingId);
  const extract = useExtractActionItems(recordingId);
  const job = useJobFor(recordingId);
  const extracting =
    extract.isPending ||
    (job?.phase === "action_items" && (job.status === "pending" || job.status === "running"));

  const open = items?.filter((i) => !i.done).length ?? 0;

  return (
    <div className="action-items-panel">
      <div className="detail-panel-head" style={{ marginTop: 18 }}>
        <div>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TasksIcon width={18} height={18} /> Aufgaben & Entscheidungen
          </h2>
          <p>
            {items && items.length > 0
              ? `${open} offen · ${items.length} insgesamt`
              : "Lass das LLM Action-Items und Beschlüsse aus dem Transkript ziehen."}
          </p>
        </div>
        <button
          className="btn"
          disabled={extracting}
          onClick={() => extract.mutate()}
          title="Erneutes Extrahieren ersetzt die Liste; Abhaken bleibt bei unverändertem Text erhalten."
        >
          {extracting ? "Extrahiere…" : items && items.length > 0 ? "Neu extrahieren" : "Extrahieren"}
        </button>
      </div>
      {job?.phase === "action_items" && job.status === "failed" && (
        <div className="detail-error">{job.error}</div>
      )}
      {items && items.length > 0 && (
        <div className="action-item-list">
          {items.map((item) => (
            <ActionItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
