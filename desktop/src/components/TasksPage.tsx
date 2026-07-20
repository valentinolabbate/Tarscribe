import { useEffect, useMemo, useRef, useState } from "react";
import { useActionItems } from "../hooks/queries";
import { api } from "../lib/api";
import type { Topic } from "../lib/types";
import { ActionItemRow } from "./ActionItemsPanel";
import { CalendarIcon, SearchIcon, TasksIcon } from "./icons";
import {
  buildTaskSections,
  filterOwnedItems,
  filterTaskItems,
  getTaskCounts,
  localIsoDate,
  type OwnerFilter,
  type TaskView,
} from "./tasks/model";
import { TasksScoreboard } from "./tasks/TasksScoreboard";
import { useToast } from "./Toast";

export function TasksPage({
  topics,
  onOpenRecording,
  focusedItemId = null,
}: {
  topics: Topic[];
  onOpenRecording: (recordingId: number, startSec?: number | null) => void;
  focusedItemId?: number | null;
}) {
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("mine");
  const [view, setView] = useState<TaskView>("open");
  const [search, setSearch] = useState("");
  const toast = useToast();
  const today = localIsoDate();
  const handledFocusedItemId = useRef<number | null>(null);

  const { data: items, isLoading, isError, error } = useActionItems({
    topicId: topicFilter,
    done: null,
  });

  useEffect(() => {
    if (focusedItemId == null) {
      handledFocusedItemId.current = null;
      return;
    }
    if (!items || handledFocusedItemId.current === focusedItemId) return;
    const focusedItem = items.find((item) => item.id === focusedItemId);
    if (!focusedItem) return;
    handledFocusedItemId.current = focusedItemId;
    if (focusedItem.kind !== "task") return;
    setTopicFilter(null);
    setOwnerFilter("all");
    setView(focusedItem.done ? "done" : "open");
    setSearch("");
  }, [focusedItemId, items]);

  const taskItems = useMemo(
    () => (items ?? []).filter((item) => item.kind === "task"),
    [items],
  );
  const ownerItems = useMemo(
    () => filterOwnedItems(taskItems, ownerFilter),
    [ownerFilter, taskItems],
  );
  const counts = useMemo(() => getTaskCounts(ownerItems, today), [ownerItems, today]);
  const visibleItems = useMemo(
    () => filterTaskItems(ownerItems, view, search, today),
    [ownerItems, search, today, view],
  );
  const sections = useMemo(
    () => buildTaskSections(visibleItems, view, today),
    [today, view, visibleItems],
  );

  const activeTopic = topics.find((topic) => topic.id === topicFilter);
  const hasDatedOpen = taskItems.some((item) => !item.done && !!item.due_date);
  const hasOnlyOwnershipMismatch =
    ownerFilter === "mine" && ownerItems.length === 0 && taskItems.length > 0;
  const hasActiveFilters =
    topicFilter != null || ownerFilter !== "mine" || view !== "open" || !!search.trim();
  const viewLabel =
    view === "overdue"
      ? "Überfällige Aufgaben"
      : view === "week"
        ? "Aufgaben der nächsten 7 Tage"
        : view === "done"
          ? "Erledigte Aufgaben"
          : "Offene Aufgaben";
  const emptyCopy = search.trim()
    ? `Keine Treffer für „${search.trim()}“. Passe die Suche oder den Fokus an.`
    : hasOnlyOwnershipMismatch
      ? "Nichts dir zugeordnet. Zeige alle Aufgaben oder lege in den Einstellungen fest, wer „Ich“ ist."
      : view === "overdue"
        ? "Keine überfälligen Aufgaben."
        : view === "week"
          ? "In den nächsten 7 Tagen ist nichts fällig."
          : view === "done"
            ? "Noch keine Aufgaben erledigt."
            : "Keine offenen Aufgaben für diese Auswahl.";

  async function exportIcs() {
    try {
      await api.downloadActionItemsIcs(topicFilter);
    } catch (exportError) {
      toast((exportError as Error).message, "error");
    }
  }

  function resetFilters() {
    setOwnerFilter("mine");
    setView("open");
    setSearch("");
    setTopicFilter(null);
  }

  return (
    <div className="page-shell tasks-page">
      <header className="tasks-header">
        <div>
          <span className="page-kicker">Arbeitsliste</span>
          <h2>Aufgaben</h2>
          <p>Prüfe offene Aufgaben, Zusagen und Fristen aus deinen Aufnahmen.</p>
        </div>
        <button
          type="button"
          className="btn tasks-export"
          onClick={exportIcs}
          disabled={!hasDatedOpen}
          title={
            hasDatedOpen
              ? "Offene Aufgaben mit Frist als Kalenderdatei exportieren"
              : "Keine offenen Aufgaben mit Fälligkeitsdatum"
          }
        >
          <CalendarIcon width={14} height={14} />
          Kalender exportieren
        </button>
      </header>

      <TasksScoreboard counts={counts} selected={view} onSelect={setView} />

      <section className="tasks-toolbar control-rail" aria-label="Liste eingrenzen">
        <label className="tasks-search">
          <SearchIcon width={15} height={15} />
          <input
            type="search"
            aria-label="Aufgaben durchsuchen"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Aufgaben durchsuchen"
          />
        </label>
        <div className="tasks-filter-group">
          <span>Verantwortung</span>
          <div className="seg" aria-label="Verantwortung wählen">
            {(["mine", "all"] as const).map((filter) => (
              <button
                type="button"
                key={filter}
                className={ownerFilter === filter ? "seg-btn active" : "seg-btn"}
                aria-pressed={ownerFilter === filter}
                onClick={() => setOwnerFilter(filter)}
              >
                {filter === "mine" ? "Meine" : "Alle"}
              </button>
            ))}
          </div>
        </div>
        <label className="tasks-topic-filter">
          <span>Bereich</span>
          <select
            value={topicFilter ?? ""}
            onChange={(event) =>
              setTopicFilter(event.target.value ? Number(event.target.value) : null)
            }
          >
            <option value="">Alle Themenbereiche</option>
            {topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.name}
              </option>
            ))}
          </select>
        </label>
        {hasActiveFilters && (
          <button type="button" className="btn ghost tasks-reset" onClick={resetFilters}>
            Zurücksetzen
          </button>
        )}
      </section>

      <div className="tasks-board-head">
        <div>
          <span className="page-kicker">
            {activeTopic
              ? activeTopic.name
              : ownerFilter === "mine"
                ? "Meine Aufgaben"
                : "Alle Aufgaben"}
          </span>
          <h3 aria-live="polite">
            {visibleItems.length} {visibleItems.length === 1 ? "Aufgabe" : "Aufgaben"}
          </h3>
        </div>
        <span>{viewLabel}</span>
      </div>

      {isLoading && <div className="tasks-empty">Lade Aufgaben…</div>}
      {!isLoading && isError && (
        <div className="tasks-empty" role="alert">
          <TasksIcon width={28} height={28} />
          <div className="big">Aufgaben konnten nicht geladen werden</div>
          <div>{error instanceof Error ? error.message : "Versuche es später erneut."}</div>
        </div>
      )}
      {!isLoading && !isError && sections.length === 0 && (
        <div className="tasks-empty">
          <TasksIcon width={28} height={28} />
          <div className="big">Keine Aufgaben</div>
          <div>{emptyCopy}</div>
          <div className="empty-action-row">
            {hasOnlyOwnershipMismatch && (
              <button type="button" className="btn ghost" onClick={() => setOwnerFilter("all")}>
                Alle Aufgaben anzeigen
              </button>
            )}
            {hasActiveFilters && (
              <button type="button" className="btn ghost" onClick={resetFilters}>
                Ansicht zurücksetzen
              </button>
            )}
          </div>
        </div>
      )}

      {!isLoading && !isError && sections.length > 0 && (
        <div className="tasks-sections work-surface">
          {sections.map((section) => (
            <section key={section.id} className={`tasks-section ${section.tone ?? ""}`}>
              <header>
                <div>
                  <h3>{section.title}</h3>
                  <p>{section.detail}</p>
                </div>
                <span>{section.items.length}</span>
              </header>
              <div className="action-item-list">
                {section.items.map((item) => (
                  <ActionItemRow
                    key={item.id}
                    item={item}
                    compact
                    focused={item.id === focusedItemId}
                    showKind={false}
                    showDue
                    showRecording
                    onOpenRecording={onOpenRecording}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
