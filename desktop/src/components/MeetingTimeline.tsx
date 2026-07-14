import { useMemo, useState } from "react";
import {
  useDeleteActionItem,
  useExtractActionItems,
  useRecordingActionItems,
  useRecordingJobs,
  useUpdateActionItem,
} from "../hooks/queries";
import { useJobFor } from "../hooks/useJobs";
import { useUndoableDelete } from "../hooks/useUndoableDelete";
import type { ActionItem, DiarizationData } from "../lib/types";
import { MemoryIcon, RefreshIcon, TrashIcon, WaveIcon } from "./icons";
import {
  activeTimelineItemId,
  sortTimelineItems,
  speakerAt,
  timelineKind,
  type TimelineKind,
} from "./meeting-timeline/model";
import { timestamp } from "./recording-detail/model";

type TimelineFilter = "all" | TimelineKind;

type TimelineDraft = {
  text: string;
  assignee: string;
  recipient: string;
  due: string;
  dueDate: string;
};

const labels: Record<TimelineKind, string> = {
  decision: "Entscheidung",
  commitment: "Zusage",
  task: "Aufgabe",
};

function dueLabel(item: ActionItem): string | null {
  if (item.due_date) {
    const date = new Date(`${item.due_date}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
    }
  }
  return item.due;
}

export function MeetingTimeline({
  recordingId,
  diarization,
  currentTime,
  playing,
  onSeek,
  onOpenTranscript,
}: {
  recordingId: number;
  diarization?: DiarizationData;
  currentTime: number;
  playing: boolean;
  onSeek: (seconds: number) => void;
  onOpenTranscript: (seconds: number) => void;
}) {
  const { data: items, isLoading, isSuccess } = useRecordingActionItems(recordingId);
  const { data: jobs, isLoading: jobsLoading } = useRecordingJobs(recordingId);
  const extract = useExtractActionItems(recordingId);
  const update = useUpdateActionItem();
  const remove = useDeleteActionItem();
  const undoDelete = useUndoableDelete();
  const liveJob = useJobFor(recordingId);
  const persistedActionJob = jobs?.find((job) => job.phase === "action_items");
  const actionJob = liveJob?.phase === "action_items" ? liveJob : persistedActionJob;
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<TimelineDraft | null>(null);
  const extracting =
    extract.isPending ||
    (actionJob?.phase === "action_items" &&
      (actionJob.status === "pending" || actionJob.status === "running"));
  const extractionFailed =
    !extracting && actionJob?.phase === "action_items" && actionJob.status === "failed";
  const loadingAnalysis = isLoading || jobsLoading;
  const activeItems = useMemo(
    () =>
      (items ?? []).filter(
        (item) => item.review_state !== "rejected" && !undoDelete.isPending(item.id),
      ),
    [items, undoDelete.isPending],
  );
  const visibleItems = useMemo(
    () =>
      sortTimelineItems(activeItems).filter(
        (item) => filter === "all" || timelineKind(item) === filter,
      ),
    [activeItems, filter],
  );
  const timedItems = visibleItems.filter((item) => item.source_start_sec != null);
  const untimedItems = visibleItems.filter((item) => item.source_start_sec == null);
  const activeId = activeTimelineItemId(timedItems, currentTime);
  const counts = activeItems.reduce(
    (result, item) => {
      if (item.review_state !== "rejected") result[timelineKind(item)] += 1;
      return result;
    },
    { decision: 0, commitment: 0, task: 0 },
  );

  function startEditing(item: ActionItem) {
    setEditingId(item.id);
    setDraft({
      text: item.text,
      assignee: item.assignee ?? "",
      recipient: item.recipient ?? "",
      due: item.due ?? "",
      dueDate: item.due_date ?? "",
    });
  }

  function stopEditing() {
    setEditingId(null);
    setDraft(null);
  }

  function saveEditing(item: ActionItem) {
    if (!draft?.text.trim()) return;
    update.mutate(
      {
        id: item.id,
        patch: {
          text: draft.text.trim(),
          assignee: draft.assignee.trim() || null,
          recipient: draft.recipient.trim() || null,
          due: draft.due.trim() || null,
          due_date: draft.dueDate || null,
        },
      },
      { onSuccess: stopEditing },
    );
  }

  function deleteItem(item: ActionItem) {
    if (editingId === item.id) stopEditing();
    undoDelete.schedule(
      item.id,
      () => remove.mutate(item.id),
      `${labels[timelineKind(item)]} gelöscht`,
    );
  }

  function renderItemContent(item: ActionItem, speaker: string | null, timed: boolean) {
    const kind = timelineKind(item);
    const due = dueLabel(item);
    const editing = editingId === item.id && draft;
    const completionLabel = item.done ? "Wieder öffnen" : "Als erledigt markieren";

    return (
      <div className="timeline-event-content">
        <div className="timeline-event-topline">
          <span className="timeline-kind">{labels[kind]}</span>
          {speaker && <span>{speaker}</span>}
          <span className={`timeline-state ${item.done ? "done" : "open"}`}>
            {item.done ? "Erledigt" : "Offen"}
          </span>
        </div>
        {editing ? (
          <form
            className="timeline-inline-edit"
            onSubmit={(event) => {
              event.preventDefault();
              saveEditing(item);
            }}
          >
            <label className="timeline-edit-text">
              <span>Inhalt</span>
              <textarea
                value={draft.text}
                onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                autoFocus
                rows={2}
                maxLength={1000}
              />
            </label>
            <div className="timeline-edit-fields">
              <label>
                <span>Verantwortlich</span>
                <input
                  value={draft.assignee}
                  onChange={(event) => setDraft({ ...draft, assignee: event.target.value })}
                  placeholder="Optional"
                />
              </label>
              <label>
                <span>Empfänger</span>
                <input
                  value={draft.recipient}
                  onChange={(event) => setDraft({ ...draft, recipient: event.target.value })}
                  placeholder="Optional"
                />
              </label>
              <label>
                <span>Frist im Wortlaut</span>
                <input
                  value={draft.due}
                  onChange={(event) => setDraft({ ...draft, due: event.target.value })}
                  placeholder="z. B. bis Freitag"
                />
              </label>
              <label>
                <span>Datum</span>
                <input
                  type="date"
                  value={draft.dueDate}
                  onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })}
                />
              </label>
            </div>
            <div className="timeline-edit-actions">
              <button type="button" className="btn ghost" onClick={stopEditing}>
                Abbrechen
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={!draft.text.trim() || update.isPending}
              >
                {update.isPending ? "Speichert…" : "Speichern"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <h3>{item.text}</h3>
            {(item.assignee || item.recipient || due) && (
              <div className="timeline-event-meta">
                {item.assignee && <span><strong>{item.assignee}</strong> verantwortlich</span>}
                {item.recipient && <span>für <strong>{item.recipient}</strong></span>}
                {due && <span>bis <strong>{due}</strong></span>}
              </div>
            )}
            {item.source_quote ? (
              <blockquote>„{item.source_quote}“</blockquote>
            ) : (
              <span className="timeline-missing-source">Belegstelle unvollständig</span>
            )}
          </>
        )}
        {!editing && (
          <div className="timeline-event-actions">
            {timed && (
              <>
                <button type="button" onClick={() => onSeek(item.source_start_sec ?? 0)}>
                  <WaveIcon width={14} height={14} /> Ab hier hören
                </button>
                <button
                  type="button"
                  onClick={() => onOpenTranscript(item.source_start_sec ?? 0)}
                >
                  Im Transkript
                </button>
              </>
            )}
            {timed && <span className="timeline-action-separator" aria-hidden="true" />}
            <button
              type="button"
              className="timeline-state-action"
              disabled={update.isPending}
              title={completionLabel}
              onClick={() => update.mutate({ id: item.id, patch: { done: !item.done } })}
            >
              {item.done ? "Wieder öffnen" : "Erledigt"}
            </button>
            <button type="button" onClick={() => startEditing(item)}>
              Bearbeiten
            </button>
            <button
              type="button"
              className="timeline-delete-action"
              aria-label={`${labels[kind]} löschen: ${item.text}`}
              onClick={() => deleteItem(item)}
            >
              <TrashIcon width={13} height={13} /> Löschen
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="detail-panel meeting-timeline">
      <div className="detail-panel-head timeline-head">
        <div>
          <span className="timeline-eyebrow">Gesprächsverlauf</span>
          <h2>Schlüsselmomente des Meetings</h2>
          <p>Beschlüsse, Zusagen und Aufgaben in der Reihenfolge, in der sie gefallen sind.</p>
        </div>
        <div className="timeline-head-mark" aria-hidden="true">
          <MemoryIcon width={19} height={19} />
          <strong>{activeItems.length}</strong>
        </div>
      </div>

      {activeItems.length > 0 && (
        <div className="timeline-filters" aria-label="Zeitstrahl filtern">
          {(
            [
              ["all", "Alle", counts.decision + counts.commitment + counts.task],
              ["decision", "Entscheidungen", counts.decision],
              ["commitment", "Zusagen", counts.commitment],
              ["task", "Aufgaben", counts.task],
            ] as Array<[TimelineFilter, string, number]>
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className={filter === id ? "active" : ""}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}<span>{count}</span>
            </button>
          ))}
        </div>
      )}

      {extractionFailed && (
        <div className="timeline-notice error">
          <strong>Analyse nicht abgeschlossen</strong>
          <span>{actionJob?.error}</span>
          {!isSuccess ? (
            <span>Vorhandene Einträge werden geprüft…</span>
          ) : activeItems.length === 0 ? (
            <button type="button" className="btn" onClick={() => extract.mutate(undefined)}>
              Erneut versuchen
            </button>
          ) : (
            <span>Bestehende Einträge bleiben unverändert.</span>
          )}
        </div>
      )}

      {(loadingAnalysis || extracting) && !extractionFailed && (
        <div className="timeline-empty analyzing">
          <RefreshIcon width={20} height={20} />
          <div><strong>Gespräch wird ausgewertet</strong><span>Entscheidungen, Zusagen und Aufgaben werden belegt.</span></div>
        </div>
      )}

      {!loadingAnalysis && !extracting && !extractionFailed && activeItems.length === 0 && (
        <div className="timeline-empty">
          <span className="timeline-empty-line" aria-hidden="true" />
          <div>
            <strong>Noch keine Schlüsselmomente erkannt</strong>
            <span>Neue Meetings werden nach dem Transkript automatisch analysiert.</span>
          </div>
          <button type="button" className="btn primary" onClick={() => extract.mutate(undefined)}>
            Jetzt analysieren
          </button>
        </div>
      )}

      {!loadingAnalysis && !extracting && activeItems.length > 0 && visibleItems.length === 0 && (
        <div className="timeline-empty compact">
          <div><strong>Nichts in dieser Auswahl</strong><span>Wähle einen anderen Ereignistyp.</span></div>
        </div>
      )}

      {timedItems.length > 0 && (
        <div className="timeline-lane">
          {timedItems.map((item) => {
            const kind = timelineKind(item);
            const speaker = speakerAt(diarization?.utterances ?? [], item.source_start_sec);
            const active = item.id === activeId;
            return (
              <article
                key={item.id}
                className={`timeline-event ${kind} ${item.done ? "done" : ""} ${active ? "active" : ""} ${active && playing ? "playing" : ""}`}
              >
                <button
                  type="button"
                  className="timeline-time"
                  onClick={() => onSeek(item.source_start_sec ?? 0)}
                  aria-label={`${timestamp(item.source_start_sec ?? 0)} abspielen`}
                >
                  {timestamp(item.source_start_sec ?? 0)}
                </button>
                <div className="timeline-track" aria-hidden="true"><span /></div>
                {renderItemContent(item, speaker, true)}
              </article>
            );
          })}
        </div>
      )}

      {untimedItems.length > 0 && (
        <section className="timeline-unplaced">
          <div className="timeline-unplaced-head">
            <div><strong>Ohne Zeitmarke</strong><span>{untimedItems.length} {untimedItems.length === 1 ? "Eintrag braucht" : "Einträge brauchen"} Prüfung.</span></div>
          </div>
          <div className="timeline-unplaced-list">
            {untimedItems.map((item) => {
              const kind = timelineKind(item);
              return (
                <article
                  key={item.id}
                  className={`timeline-event timeline-event-untimed ${kind} ${item.done ? "done" : ""}`}
                >
                  <span className="timeline-time timeline-no-time" aria-label="Keine Zeitmarke">–</span>
                  <div className="timeline-track" aria-hidden="true"><span /></div>
                  {renderItemContent(item, null, false)}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
