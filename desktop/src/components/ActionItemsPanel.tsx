import { useEffect, useRef, useState } from "react";
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
import { EvidenceTrail } from "./EvidenceTrail";
import { CalendarIcon, TrashIcon } from "./icons";

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
  showKind = true,
  showDue = true,
  compact = false,
  focused = false,
  onOpenRecording,
}: {
  item: ActionItem;
  showRecording?: boolean;
  showKind?: boolean;
  showDue?: boolean;
  compact?: boolean;
  focused?: boolean;
  onOpenRecording?: (recordingId: number, startSec?: number | null) => void;
}) {
  const update = useUpdateActionItem();
  const syncCalendar = useSyncActionItemCalendar();
  const del = useDeleteActionItem();
  const undoDelete = useUndoableDelete();
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(item.text);
  const [draftAssignee, setDraftAssignee] = useState(item.assignee ?? "");
  const [draftDue, setDraftDue] = useState(item.due ?? "");
  const [draftDueDate, setDraftDueDate] = useState(item.due_date ?? "");
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focused || !rowRef.current) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    rowRef.current.scrollIntoView({ block: "center", behavior });
    rowRef.current.focus({ preventScroll: true });
  }, [focused]);

  if (undoDelete.isPending(item.id)) return null;

  function startEditing() {
    setDraftText(item.text);
    setDraftAssignee(item.assignee ?? "");
    setDraftDue(item.due ?? "");
    setDraftDueDate(item.due_date ?? "");
    setEditing(true);
  }

  function saveEditing() {
    const text = draftText.trim();
    if (!text) return;
    update.mutate(
      {
        id: item.id,
        patch: {
          text,
          assignee: draftAssignee.trim() || null,
          due: draftDue.trim() || null,
          due_date: draftDueDate || null,
        },
      },
      { onSuccess: () => setEditing(false) },
    );
  }

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
  const completionLabel =
    item.kind === "decision"
      ? item.done
        ? "Entscheidung reaktivieren"
        : "Entscheidung archivieren"
      : item.done
        ? "Als offen markieren"
        : "Als erledigt markieren";
  const calendarControl = calendarLabel ? (
    item.calendar_status === "pending_approval" || item.calendar_status === "failed" ? (
      <button
        type="button"
        className={`action-calendar ${item.calendar_status}`}
        title={item.calendar_error ?? "In CalDAV-Kalender exportieren"}
        disabled={syncCalendar.isPending}
        onClick={() => syncCalendar.mutate(item.id)}
      >
        <CalendarIcon width={12} height={12} />
        {item.calendar_status === "failed" ? "Erneut versuchen" : "In Kalender"}
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
  ) : null;

  function deleteItem() {
    undoDelete.schedule(
      item.id,
      () => del.mutate(item.id),
      item.kind === "decision" ? "Entscheidung gelöscht" : "Aufgabe gelöscht",
    );
  }

  return (
    <div
      ref={rowRef}
      data-action-item-id={item.id}
      tabIndex={focused ? -1 : undefined}
      className={`action-item ${compact ? "compact" : ""} ${item.done ? "done" : ""} ${overdue ? "overdue" : ""} ${focused ? "focused" : ""}`}
    >
      <input
        type="checkbox"
        checked={item.done}
        onChange={(e) => update.mutate({ id: item.id, patch: { done: e.target.checked } })}
        title={completionLabel}
        aria-label={`${completionLabel}: ${item.text}`}
      />
      <div className="action-item-body">
        {editing ? (
          <form
            className="action-item-edit"
            onSubmit={(event) => {
              event.preventDefault();
              saveEditing();
            }}
          >
            <label className="action-edit-text">
              <span>Text</span>
              <input
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                autoFocus
                maxLength={1000}
              />
            </label>
            <div className="action-edit-fields">
              <label>
                <span>Verantwortlich</span>
                <input
                  value={draftAssignee}
                  onChange={(event) => setDraftAssignee(event.target.value)}
                  placeholder="Optional"
                />
              </label>
              <label>
                <span>Frist im Wortlaut</span>
                <input
                  value={draftDue}
                  onChange={(event) => setDraftDue(event.target.value)}
                  placeholder="z. B. bis Freitag"
                />
              </label>
              <label>
                <span>Datum</span>
                <input
                  type="date"
                  value={draftDueDate}
                  onChange={(event) => setDraftDueDate(event.target.value)}
                />
              </label>
            </div>
            <div className="action-edit-actions">
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                Abbrechen
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={!draftText.trim() || update.isPending}
              >
                {update.isPending ? "Speichert…" : "Speichern"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <span className="action-item-text">{item.text}</span>
            {showRecording && onOpenRecording && (
              <EvidenceTrail
                recordingId={item.recording_id}
                recordingTitle={item.recording_title}
                startSec={item.source_start_sec}
                quote={item.source_quote}
                topicName={item.topic_name}
                topicColor={item.topic_color}
                compact
                missing={item.attention_flags.includes("missing_source")}
                onOpenRecording={onOpenRecording}
              />
            )}
            <div className="action-item-meta">
              {showKind && (
                <span className={`action-kind ${item.kind}`}>
                  {item.kind === "decision" ? "Entscheidung" : "Aufgabe"}
                </span>
              )}
              {item.assignee && <span>{item.assignee}</span>}
              {item.is_mine ? (
                <span className="action-mine" title="Dir zugeordnet">Ich</span>
              ) : (
                <button
                  type="button"
                  className={`action-import ${item.include_in_tasks ? "on" : ""}`}
                  title={
                    item.include_in_tasks
                      ? "Aus meiner Liste entfernen"
                      : "In meine Liste übernehmen"
                  }
                  onClick={() =>
                    update.mutate({ id: item.id, patch: { include_in_tasks: !item.include_in_tasks } })
                  }
                >
                  {item.include_in_tasks ? "★ In meiner Liste" : "☆ Übernehmen"}
                </button>
              )}
              {showDue && !item.due_date && item.due && <span>{item.due}</span>}
              {showDue && (
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
              )}
              {compact ? (
                <details className="action-item-more">
                  <summary role="button" aria-label="Weitere Aktionen">•••</summary>
                  <div className="action-item-more-panel">
                    <button type="button" onClick={startEditing}>
                      Bearbeiten
                    </button>
                    {showDue && calendarControl}
                    <button type="button" className="danger" onClick={deleteItem}>
                      <TrashIcon width={13} height={13} />
                      Löschen
                    </button>
                  </div>
                </details>
              ) : (
                <>
                  <button type="button" className="action-edit-trigger" onClick={startEditing}>
                    Bearbeiten
                  </button>
                  {calendarControl}
                </>
              )}
            </div>
          </>
        )}
      </div>
      {!compact && (
        <button
          type="button"
          className="topic-del"
          title="Eintrag löschen"
          aria-label={`Eintrag löschen: ${item.text}`}
          onClick={deleteItem}
        >
          <TrashIcon width={13} height={13} />
        </button>
      )}
    </div>
  );
}

/** Per-recording action items: extraction trigger + checkable list. */
export function ActionItemsPanel({ recordingId }: { recordingId: number }) {
  const { data: items } = useRecordingActionItems(recordingId);
  const extract = useExtractActionItems(recordingId);
  const job = useJobFor(recordingId);
  const [clarification, setClarification] = useState("");
  const extracting =
    extract.isPending ||
    (job?.phase === "action_items" && (job.status === "pending" || job.status === "running"));

  const open = items?.filter((i) => !i.done).length ?? 0;

  return (
    <div className="action-items-panel">
      <div className="analysis-action-row">
        <span className="rec-sub">
          {items && items.length > 0
            ? `${open} offen · ${items.length} insgesamt`
            : "Noch keine Aufgaben extrahiert."}
        </span>
        <button
          className="btn"
          disabled={extracting}
          onClick={() => extract.mutate(clarification.trim() || undefined)}
          title="Erneutes Extrahieren ersetzt die Liste; Abhaken bleibt bei unverändertem Text erhalten."
        >
          {extracting ? "Extrahiere…" : items && items.length > 0 ? "Neu extrahieren" : "Extrahieren"}
        </button>
      </div>
      <label className="analysis-clarification">
        <span>Klärung zur Erkennung <small>optional</small></span>
        <textarea
          value={clarification}
          onChange={(event) => setClarification(event.target.value)}
          maxLength={4000}
          rows={2}
          placeholder="z. B. Das Produkt heißt Tarscribe, nicht Tarscript."
        />
      </label>
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
