import {
  useDeleteActionItem,
  useExtractActionItems,
  useRecordingActionItems,
  useSyncActionItemCalendar,
  useUpdateActionItem,
} from "../hooks/queries";
import { useJobFor } from "../hooks/useJobs";
import { useUndoableDelete } from "../hooks/useUndoableDelete";
import type { ActionItem } from "../lib/types";
import { CalendarIcon, TasksIcon, TrashIcon } from "./icons";

/** Today as a local ISO date (YYYY-MM-DD), matching the <input type="date"> format. */
function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function isOverdue(item: ActionItem): boolean {
  return !item.done && !!item.due_date && item.due_date < todayIso();
}

function fmtDueDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
}

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
  const syncCalendar = useSyncActionItemCalendar();
  const del = useDeleteActionItem();
  const undoDelete = useUndoableDelete();

  if (undoDelete.isPending(item.id)) return null;

  const overdue = isOverdue(item);
  const calendarLabel =
    item.calendar_status === "synced"
      ? "Kalender"
      : item.calendar_status === "pending_approval"
        ? "Freigabe"
        : item.calendar_status === "failed"
          ? "Fehler"
          : item.calendar_status === "not_configured"
            ? "Kalender offen"
            : null;
  return (
    <div className={`action-item ${item.done ? "done" : ""} ${overdue ? "overdue" : ""}`}>
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
          {item.is_mine ? (
            <span className="action-mine" title="Dir zugeordnet">Ich</span>
          ) : (
            <button
              className={`action-import ${item.include_in_tasks ? "on" : ""}`}
              title={
                item.include_in_tasks
                  ? "Aus „Meine Aufgaben“ entfernen"
                  : "Zu „Meine Aufgaben“ hinzufügen"
              }
              onClick={() =>
                update.mutate({ id: item.id, patch: { include_in_tasks: !item.include_in_tasks } })
              }
            >
              {item.include_in_tasks ? "★ Meine Aufgabe" : "☆ Übernehmen"}
            </button>
          )}
          {!item.due_date && item.due && <span>bis {item.due}</span>}
          <label className={`action-due ${overdue ? "overdue" : ""}`} title="Fälligkeitsdatum setzen">
            {item.due_date ? `📅 ${fmtDueDate(item.due_date)}` : "+ Frist"}
            <input
              type="date"
              value={item.due_date ?? ""}
              onChange={(e) =>
                update.mutate({ id: item.id, patch: { due_date: e.target.value } })
              }
            />
          </label>
          {showRecording && item.recording_title && (
            <button
              className="action-item-rec"
              onClick={() => onOpenRecording?.(item.recording_id)}
              title="Aufnahme öffnen"
            >
              {item.recording_title}
            </button>
          )}
          {calendarLabel && (
            item.calendar_status === "pending_approval" || item.calendar_status === "failed" ? (
              <button
                className={`action-calendar ${item.calendar_status}`}
                title={item.calendar_error ?? "In CalDAV-Kalender exportieren"}
                disabled={syncCalendar.isPending}
                onClick={() => syncCalendar.mutate(item.id)}
              >
                <CalendarIcon width={12} height={12} />
                {item.calendar_status === "failed" ? "Retry" : "In Kalender"}
              </button>
            ) : (
              <span
                className={`action-calendar ${item.calendar_status}`}
                title={item.calendar_error ?? undefined}
              >
                <CalendarIcon width={12} height={12} />
                {calendarLabel}
              </span>
            )
          )}
        </span>
      </div>
      <button
        className="topic-del"
        title="Eintrag löschen"
        onClick={() =>
          undoDelete.schedule(
            item.id,
            () => del.mutate(item.id),
            item.kind === "decision" ? "Entscheidung gelöscht" : "Aufgabe gelöscht",
          )
        }
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
