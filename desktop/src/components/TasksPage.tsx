import { useMemo, useState } from "react";
import { useActionItems } from "../hooks/queries";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import type { ActionItem, Topic } from "../lib/types";
import { ActionItemRow, isOverdue } from "./ActionItemsPanel";
import { TasksIcon } from "./icons";
import { TasksScoreboard } from "./tasks/TasksScoreboard";
import { useToast } from "./Toast";

type DoneFilter = "open" | "all" | "done";
type DueFilter = "any" | "overdue" | "week";
type OwnerFilter = "mine" | "all";

interface TaskGroup {
  title: string;
  created: string;
  items: ActionItem[];
}

/** Local ISO date (YYYY-MM-DD) `days` from today. */
function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Global, checkable view of all extracted action items across recordings. */
export function TasksPage({
  topics,
  onOpenRecording,
}: {
  topics: Topic[];
  onOpenRecording: (recordingId: number) => void;
}) {
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [doneFilter, setDoneFilter] = useState<DoneFilter>("open");
  const [dueFilter, setDueFilter] = useState<DueFilter>("any");
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("mine");
  const toast = useToast();

  const { data: items, isLoading } = useActionItems({
    topicId: topicFilter,
    done: null,
  });

  // "mine": only items assigned to the configured "me" speaker plus ones the user
  // explicitly imported; "all": every extracted item across recordings.
  const ownerItems = useMemo(() => {
    const list = items ?? [];
    return ownerFilter === "all" ? list : list.filter((i) => i.is_mine || i.include_in_tasks);
  }, [items, ownerFilter]);

  const statusItems = useMemo(() => {
    if (doneFilter === "all") return ownerItems;
    return ownerItems.filter((item) => item.done === (doneFilter === "done"));
  }, [doneFilter, ownerItems]);

  const visibleItems = useMemo(() => {
    if (dueFilter === "any") return statusItems;
    const weekLimit = isoInDays(7);
    return statusItems.filter((item) => {
      if (dueFilter === "overdue") return isOverdue(item);
      // "week": open items due within the next 7 days (incl. overdue).
      return !item.done && !!item.due_date && item.due_date <= weekLimit;
    });
  }, [dueFilter, statusItems]);

  async function exportIcs() {
    try {
      await api.downloadActionItemsIcs(topicFilter);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  // Group by recording, keeping the backend order (newest recording first).
  const groups = useMemo(() => {
    const map = new Map<number, TaskGroup>();
    for (const item of visibleItems) {
      const group = map.get(item.recording_id) ?? {
        title: item.recording_title ?? "Aufnahme",
        created: item.created_at,
        items: [],
      };
      group.items.push(item);
      map.set(item.recording_id, group);
    }
    return [...map.entries()];
  }, [visibleItems]);

  const openCount = ownerItems.filter((i) => !i.done).length;
  const doneCount = ownerItems.filter((i) => i.done).length;
  const overdueCount = ownerItems.filter(isOverdue).length;
  const weekLimit = isoInDays(7);
  const weekCount = ownerItems.filter((i) => !i.done && !!i.due_date && i.due_date <= weekLimit).length;
  const decisionCount = ownerItems.filter((i) => i.kind === "decision").length;
  const taskCount = ownerItems.filter((i) => i.kind === "task").length;
  const activeTopic = topics.find((topic) => topic.id === topicFilter);
  const hasDatedOpen = ownerItems.some((i) => !i.done && !!i.due_date);
  const hasActiveFilters =
    topicFilter != null || doneFilter !== "open" || dueFilter !== "any" || ownerFilter !== "mine";
  const hasOnlyOwnershipMismatch =
    ownerFilter === "mine" && ownerItems.length === 0 && (items?.length ?? 0) > 0;
  const emptyCopy = hasOnlyOwnershipMismatch
    ? "Nichts dir zugeordnet. Lege in den Einstellungen fest, wer „Ich“ ist, oder übernimm Einträge über „Alle“."
    : dueFilter === "overdue"
      ? "Keine überfälligen Einträge. Guter Zustand."
      : dueFilter === "week"
        ? "Keine offenen Einträge mit Frist in den nächsten 7 Tagen."
        : doneFilter === "done"
          ? "Noch nichts erledigt für diesen Filter."
          : doneFilter === "open"
            ? "Nichts offen — oder es wurde noch nichts extrahiert."
            : "Für diesen Filter gibt es keine Einträge.";

  function resetFilters() {
    setOwnerFilter("mine");
    setDoneFilter("open");
    setDueFilter("any");
    setTopicFilter(null);
  }

  return (
    <div className="tasks-page">
      <header className="tasks-hero">
        <div className="tasks-hero-copy">
          <span className="page-kicker">Aufgaben</span>
          <h2>Aufgaben-Zentrale</h2>
          <p>
            Aus Aufnahmen extrahierte Aufgaben und Beschlüsse, sortiert nach Zuständigkeit,
            Frist und Ursprung.
          </p>
        </div>
        <TasksScoreboard
          openCount={openCount}
          overdueCount={overdueCount}
          weekCount={weekCount}
          doneCount={doneCount}
        />
      </header>

      <section className="tasks-controls" aria-label="Aufgabenfilter">
        <div className="tasks-filter-group">
          <span>Zuständig</span>
          <div className="seg">
            {(["mine", "all"] as const).map((f) => (
              <button
                key={f}
                className={ownerFilter === f ? "seg-btn active" : "seg-btn"}
                onClick={() => setOwnerFilter(f)}
                title={
                  f === "mine"
                    ? "Nur mir zugeordnete und übernommene Einträge"
                    : "Alle extrahierten Einträge aller Sprecher"
                }
              >
                {f === "mine" ? "Meine" : "Alle"}
              </button>
            ))}
          </div>
        </div>
        <div className="tasks-filter-group">
          <span>Status</span>
          <div className="seg">
            {(["open", "all", "done"] as const).map((f) => (
              <button
                key={f}
                className={doneFilter === f ? "seg-btn active" : "seg-btn"}
                onClick={() => setDoneFilter(f)}
              >
                {f === "open" ? "Offen" : f === "all" ? "Alle" : "Erledigt"}
              </button>
            ))}
          </div>
        </div>
        <div className="tasks-filter-group">
          <span>Frist</span>
          <div className="seg">
            {(["any", "overdue", "week"] as const).map((f) => (
              <button
                key={f}
                className={dueFilter === f ? "seg-btn active" : "seg-btn"}
                onClick={() => setDueFilter(f)}
                title={
                  f === "any"
                    ? "Alle Fristen"
                    : f === "overdue"
                      ? "Überfällige Aufgaben"
                      : "Fällig in den nächsten 7 Tagen"
                }
              >
                {f === "any" ? "Alle" : f === "overdue" ? "Überfällig" : "7 Tage"}
              </button>
            ))}
          </div>
        </div>
        <label className="tasks-topic-filter">
          Bereich
          <select
            value={topicFilter ?? ""}
            onChange={(e) => setTopicFilter(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Alle Themenbereiche</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <div className="tasks-control-actions">
          {hasActiveFilters && (
            <button className="btn ghost" onClick={resetFilters}>
              Zurücksetzen
            </button>
          )}
          <button
            className="btn"
            onClick={exportIcs}
            disabled={!hasDatedOpen}
            title={
              hasDatedOpen
                ? "Offene Aufgaben mit Frist als Kalender (.ics) exportieren"
                : "Keine offenen Aufgaben mit Fälligkeitsdatum"
            }
          >
            Kalender exportieren
          </button>
        </div>
      </section>

      <div className="tasks-board-head">
        <div>
          <span className="page-kicker">
            {activeTopic ? activeTopic.name : ownerFilter === "mine" ? "Meine Liste" : "Alle Einträge"}
          </span>
          <h3>{visibleItems.length} Einträge angezeigt</h3>
        </div>
        <div className="tasks-balance">
          <span>{taskCount} Aufgaben</span>
          <span>{decisionCount} Entscheidungen</span>
        </div>
      </div>

      {isLoading && <div className="tasks-empty">Lade…</div>}
      {!isLoading && groups.length === 0 && (
        <div className="tasks-empty">
          <TasksIcon width={28} height={28} />
          <div className="big">Keine Einträge</div>
          <div>{emptyCopy}</div>
          <div className="empty-action-row">
            {hasOnlyOwnershipMismatch && (
              <button className="btn ghost" onClick={() => setOwnerFilter("all")}>
                Alle Einträge anzeigen
              </button>
            )}
            {hasActiveFilters && (
              <button className="btn ghost" onClick={resetFilters}>
                Filter zurücksetzen
              </button>
            )}
          </div>
        </div>
      )}

      {groups.map(([recordingId, group]) => (
        <section key={recordingId} className="tasks-group">
          <div className="tasks-group-head">
            <div>
              <button
                className="tasks-group-title"
                onClick={() => onOpenRecording(recordingId)}
                title="Aufnahme öffnen"
              >
                {group.title}
              </button>
              <span>{fmtDate(group.created)}</span>
            </div>
            <div className="tasks-group-meta">
              <span>{group.items.filter((item) => !item.done).length} offen</span>
              {group.items.some(isOverdue) && <span className="urgent">überfällig</span>}
              <span>{group.items.filter((item) => item.kind === "decision").length} Beschlüsse</span>
            </div>
          </div>
          <div className="action-item-list">
            {group.items.map((item) => (
              <ActionItemRow
                key={item.id}
                item={item}
                showRecording={false}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
