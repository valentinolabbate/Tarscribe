export function TasksScoreboard({
  openCount,
  overdueCount,
  weekCount,
  doneCount,
}: {
  openCount: number;
  overdueCount: number;
  weekCount: number;
  doneCount: number;
}) {
  return (
    <div className="tasks-scoreboard" aria-label="Aufgabenüberblick">
      <div className="tasks-score-card primary">
        <strong>{openCount}</strong>
        <span>Offen</span>
      </div>
      <div className={overdueCount > 0 ? "tasks-score-card urgent" : "tasks-score-card"}>
        <strong>{overdueCount}</strong>
        <span>Überfällig</span>
      </div>
      <div className="tasks-score-card">
        <strong>{weekCount}</strong>
        <span>Diese Woche</span>
      </div>
      <div className="tasks-score-card">
        <strong>{doneCount}</strong>
        <span>Erledigt</span>
      </div>
    </div>
  );
}
