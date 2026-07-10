import { useMemo, useState } from "react";
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
  type TaskKind,
  type TaskView,
} from "./tasks/model";
import { TasksScoreboard } from "./tasks/TasksScoreboard";
import { useToast } from "./Toast";

export function TasksPage({
  topics,
  onOpenRecording,
}: {
  topics: Topic[];
  onOpenRecording: (recordingId: number) => void;
}) {
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("mine");
  const [kind, setKind] = useState<TaskKind>("task");
  const [view, setView] = useState<TaskView>("open");
  const [search, setSearch] = useState("");
  const toast = useToast();
  const today = localIsoDate();

  const { data: items, isLoading, isError, error } = useActionItems({
    topicId: topicFilter,
    done: null,
  });

  const ownerItems = useMemo(
    () => filterOwnedItems(items ?? [], ownerFilter),
    [items, ownerFilter],
  );
  const taskCounts = useMemo(() => getTaskCounts(ownerItems, "task", today), [ownerItems, today]);
  const decisionCounts = useMemo(
    () => getTaskCounts(ownerItems, "decision", today),
    [ownerItems, today],
  );
  const counts = kind === "task" ? taskCounts : decisionCounts;
  const visibleItems = useMemo(
    () => filterTaskItems(ownerItems, kind, view, search, today),
    [kind, ownerItems, search, today, view],
  );
  const sections = useMemo(
    () => buildTaskSections(visibleItems, kind, view, today),
    [kind, today, view, visibleItems],
  );

  const activeTopic = topics.find((topic) => topic.id === topicFilter);
  const hasDatedOpen = (items ?? []).some((item) => !item.done && !!item.due_date);
  const selectedKindRawCount = (items ?? []).filter((item) => item.kind === kind).length;
  const selectedKindOwnerCount = ownerItems.filter((item) => item.kind === kind).length;
  const hasOnlyOwnershipMismatch =
    ownerFilter === "mine" && selectedKindOwnerCount === 0 && selectedKindRawCount > 0;
  const hasActiveFilters =
    topicFilter != null || ownerFilter !== "mine" || kind !== "task" || view !== "open" || !!search.trim();
  const viewLabel =
    kind === "decision"
      ? view === "done"
        ? "Archivierte Entscheidungen"
        : "Aktuelle Entscheidungen"
      : view === "overdue"
        ? "Überfällige Aufgaben"
        : view === "week"
          ? "Aufgaben der nächsten 7 Tage"
          : view === "done"
            ? "Erledigte Aufgaben"
            : "Offene Aufgaben";
  const emptyCopy = search.trim()
    ? `Keine Treffer für „${search.trim()}“. Passe die Suche oder den Fokus an.`
    : hasOnlyOwnershipMismatch
      ? "Nichts dir zugeordnet. Zeige alle Einträge oder lege in den Einstellungen fest, wer „Ich“ ist."
      : view === "overdue"
        ? "Keine überfälligen Aufgaben."
        : view === "week"
          ? "In den nächsten 7 Tagen ist nichts fällig."
          : view === "done"
            ? kind === "decision"
              ? "Noch keine Entscheidungen archiviert."
              : "Noch keine Aufgaben erledigt."
            : kind === "decision"
              ? "Keine aktuellen Entscheidungen für diese Auswahl."
              : "Keine offenen Aufgaben für diese Auswahl.";

  async function exportIcs() {
    try {
      await api.downloadActionItemsIcs(topicFilter);
    } catch (exportError) {
      toast((exportError as Error).message, "error");
    }
  }

  function selectKind(nextKind: TaskKind) {
    setKind(nextKind);
    setView("open");
  }

  function resetFilters() {
    setOwnerFilter("mine");
    setKind("task");
    setView("open");
    setSearch("");
    setTopicFilter(null);
  }

  return (
    <div className="tasks-page">
      <header className="tasks-header">
        <div>
          <span className="page-kicker">Aufgaben</span>
          <h2>Was jetzt ansteht</h2>
          <p>Prüfe Zusagen, Fristen und Entscheidungen aus deinen Aufnahmen.</p>
        </div>
        <button
          type="button"
          className="btn tasks-export"
          onClick={exportIcs}
          disabled={!hasDatedOpen}
          title={
            hasDatedOpen
              ? "Offene Einträge mit Frist als Kalenderdatei exportieren"
              : "Keine offenen Einträge mit Fälligkeitsdatum"
          }
        >
          <CalendarIcon width={14} height={14} />
          Kalender exportieren
        </button>
      </header>

      <div className="tasks-kind-switch" role="tablist" aria-label="Eintragstyp">
        <button
          type="button"
          role="tab"
          aria-selected={kind === "task"}
          className={kind === "task" ? "active" : ""}
          onClick={() => selectKind("task")}
        >
          Aufgaben <span>{taskCounts.total}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === "decision"}
          className={kind === "decision" ? "active" : ""}
          onClick={() => selectKind("decision")}
        >
          Entscheidungen <span>{decisionCounts.total}</span>
        </button>
      </div>

      <TasksScoreboard counts={counts} kind={kind} selected={view} onSelect={setView} />

      <section className="tasks-toolbar" aria-label="Liste eingrenzen">
        <label className="tasks-search">
          <SearchIcon width={15} height={15} />
          <input
            type="search"
            aria-label="Einträge durchsuchen"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={kind === "task" ? "Aufgaben durchsuchen" : "Entscheidungen durchsuchen"}
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
            {activeTopic ? activeTopic.name : ownerFilter === "mine" ? "Meine Liste" : "Alle Einträge"}
          </span>
          <h3 aria-live="polite">
            {visibleItems.length} {visibleItems.length === 1 ? "Eintrag" : "Einträge"}
          </h3>
        </div>
        <span>{viewLabel}</span>
      </div>

      {isLoading && <div className="tasks-empty">Lade Einträge…</div>}
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
          <div className="big">Keine Einträge</div>
          <div>{emptyCopy}</div>
          <div className="empty-action-row">
            {hasOnlyOwnershipMismatch && (
              <button type="button" className="btn ghost" onClick={() => setOwnerFilter("all")}>
                Alle Einträge anzeigen
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
        <div className="tasks-sections">
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
                    showKind={false}
                    showDue={kind === "task"}
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
