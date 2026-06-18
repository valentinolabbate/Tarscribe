import { useMemo, useState } from "react";
import { useActionItems } from "../hooks/queries";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import type { ActionItem, Topic } from "../lib/types";
import { ActionItemRow, isOverdue } from "./ActionItemsPanel";
import { TasksIcon } from "./icons";
import { useToast } from "./Toast";

type DoneFilter = "open" | "all" | "done";
type DueFilter = "any" | "overdue" | "week";
type OwnerFilter = "mine" | "all";

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
    done: doneFilter === "all" ? null : doneFilter === "done",
  });

  // "mine": only items assigned to the configured "me" speaker plus ones the user
  // explicitly imported; "all": every extracted item across recordings.
  const ownerItems = useMemo(() => {
    const list = items ?? [];
    return ownerFilter === "all" ? list : list.filter((i) => i.is_mine || i.include_in_tasks);
  }, [items, ownerFilter]);

  const visibleItems = useMemo(() => {
    if (dueFilter === "any") return ownerItems;
    const weekLimit = isoInDays(7);
    return ownerItems.filter((item) => {
      if (dueFilter === "overdue") return isOverdue(item);
      // "week": open items due within the next 7 days (incl. overdue).
      return !item.done && !!item.due_date && item.due_date <= weekLimit;
    });
  }, [ownerItems, dueFilter]);

  async function exportIcs() {
    try {
      await api.downloadActionItemsIcs(topicFilter);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  // Group by recording, keeping the backend order (newest recording first).
  const groups = useMemo(() => {
    const map = new Map<number, { title: string; created: string; items: ActionItem[] }>();
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
  const hasDatedOpen = ownerItems.some((i) => !i.done && !!i.due_date);

  return (
    <div className="tasks-page">
      <header className="start-header">
        <div className="start-header-text">
          <span className="page-kicker">Aufgaben</span>
          <h2>Action-Items & Entscheidungen</h2>
          <p>
            Aus deinen Aufnahmen extrahierte Aufgaben und Beschlüsse — über alle Themenbereiche
            hinweg abhakbar. Die Extraktion startest du auf der Detailseite einer Aufnahme im
            Tab „Zusammenfassung".
          </p>
        </div>
        <div className="start-stats">
          <div className="stat">
            <strong>{openCount}</strong>
            <span>Offen</span>
          </div>
          <div className="stat">
            <strong>{visibleItems.length}</strong>
            <span>Angezeigt</span>
          </div>
        </div>
      </header>

      <div className="tasks-filters">
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
              {f === "any" ? "Alle Fristen" : f === "overdue" ? "Überfällig" : "Diese Woche"}
            </button>
          ))}
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <button
          className="btn ghost"
          onClick={exportIcs}
          disabled={!hasDatedOpen}
          title={
            hasDatedOpen
              ? "Offene Aufgaben mit Frist als Kalender (.ics) exportieren"
              : "Keine offenen Aufgaben mit Fälligkeitsdatum"
          }
        >
          In Kalender (.ics)
        </button>
        <select
          value={topicFilter ?? ""}
          onChange={(e) => setTopicFilter(e.target.value ? Number(e.target.value) : null)}
          style={{ maxWidth: 200 }}
        >
          <option value="">Alle Themenbereiche</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <div className="tasks-empty">Lade…</div>}
      {!isLoading && groups.length === 0 && (
        <div className="tasks-empty">
          <TasksIcon width={28} height={28} />
          <div className="big">Keine Einträge</div>
          <div>
            {ownerFilter === "mine" && (items?.length ?? 0) > 0
              ? "Nichts dir zugeordnet. Lege in den Einstellungen fest, wer „Ich“ ist, oder übernimm Einträge über „Alle“."
              : doneFilter === "open"
                ? "Nichts offen — oder es wurde noch nichts extrahiert."
                : "Für diesen Filter gibt es keine Einträge."}
          </div>
        </div>
      )}

      {groups.map(([recordingId, group]) => (
        <section key={recordingId} className="tasks-group">
          <div className="tasks-group-head">
            <button
              className="tasks-group-title"
              onClick={() => onOpenRecording(recordingId)}
              title="Aufnahme öffnen"
            >
              {group.title}
            </button>
            <span>{fmtDate(group.created)}</span>
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
