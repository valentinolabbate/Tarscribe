import type { TaskCounts, TaskKind, TaskView } from "./model";

export function TasksScoreboard({
  counts,
  kind,
  selected,
  onSelect,
}: {
  counts: TaskCounts;
  kind: TaskKind;
  selected: TaskView;
  onSelect: (view: TaskView) => void;
}) {
  const entries: Array<{
    id: TaskView;
    label: string;
    detail: string;
    count: number;
    tone?: "urgent";
  }> =
    kind === "task"
      ? [
          { id: "open", label: "Offen", detail: "Alle aktiven", count: counts.open },
          {
            id: "overdue",
            label: "Überfällig",
            detail: "Frist verpasst",
            count: counts.overdue,
            tone: "urgent",
          },
          { id: "week", label: "7 Tage", detail: "Ab heute", count: counts.week },
          { id: "done", label: "Erledigt", detail: "Abgeschlossen", count: counts.done },
        ]
      : [
          { id: "open", label: "Aktuell", detail: "Aktive Beschlüsse", count: counts.open },
          { id: "done", label: "Archiviert", detail: "Abgeschlossen", count: counts.done },
        ];

  return (
    <div className={`tasks-scoreboard ${kind === "decision" ? "compact" : ""}`} aria-label="Fokus wählen">
      {entries.map((entry) => (
        <button
          type="button"
          key={entry.id}
          className={`tasks-score-card ${selected === entry.id ? "active" : ""} ${entry.tone ?? ""}`}
          aria-pressed={selected === entry.id}
          onClick={() => onSelect(entry.id)}
        >
          <strong>{entry.count}</strong>
          <span>{entry.label}</span>
          <small>{entry.detail}</small>
        </button>
      ))}
    </div>
  );
}
