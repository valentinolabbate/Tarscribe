import { useMemo, useState } from "react";
import { useActionItems } from "../hooks/queries";
import { fmtDate } from "../lib/format";
import type { ActionItem, Topic } from "../lib/types";
import { ActionItemRow } from "./ActionItemsPanel";
import { TasksIcon } from "./icons";

type DoneFilter = "open" | "all" | "done";

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

  const { data: items, isLoading } = useActionItems({
    topicId: topicFilter,
    done: doneFilter === "all" ? null : doneFilter === "done",
  });

  // Group by recording, keeping the backend order (newest recording first).
  const groups = useMemo(() => {
    const map = new Map<number, { title: string; created: string; items: ActionItem[] }>();
    for (const item of items ?? []) {
      const group = map.get(item.recording_id) ?? {
        title: item.recording_title ?? "Aufnahme",
        created: item.created_at,
        items: [],
      };
      group.items.push(item);
      map.set(item.recording_id, group);
    }
    return [...map.entries()];
  }, [items]);

  const openCount = items?.filter((i) => !i.done).length ?? 0;

  return (
    <div className="tasks-page">
      <header className="start-hero">
        <div>
          <span className="page-kicker">Aufgaben</span>
          <h2>Action-Items & Entscheidungen</h2>
          <p>
            Aus deinen Aufnahmen extrahierte Aufgaben und Beschlüsse — über alle Themenbereiche
            hinweg abhakbar. Die Extraktion startest du auf der Detailseite einer Aufnahme im
            Tab „Zusammenfassung".
          </p>
        </div>
        <div className="start-stats">
          <div>
            <strong>{openCount}</strong>
            <span>Offen</span>
          </div>
          <div>
            <strong>{items?.length ?? 0}</strong>
            <span>Angezeigt</span>
          </div>
        </div>
      </header>

      <div className="tasks-filters">
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
            {doneFilter === "open"
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
