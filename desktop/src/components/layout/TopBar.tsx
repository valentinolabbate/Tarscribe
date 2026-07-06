import { useUpdateTopic } from "../../hooks/queries";
import type { Recording, Topic } from "../../lib/types";
import { GlobalRecordingIndicator } from "../GlobalRecordingIndicator";
import { CalendarIcon, FolderIcon } from "../icons";

function TopicCalendarControl({ topic }: { topic: Topic }) {
  const update = useUpdateTopic();
  return (
    <label
      className={`topic-calendar-control ${topic.calendar_export_mode}`}
      title="Kalender-Export für erkannte Aufgaben"
    >
      <CalendarIcon width={16} height={16} />
      <select
        value={topic.calendar_export_mode}
        disabled={update.isPending}
        onChange={(event) => {
          update.mutate({
            id: topic.id,
            patch: { calendar_export_mode: event.target.value as Topic["calendar_export_mode"] },
          });
        }}
      >
        <option value="off">Kalender aus</option>
        <option value="approval">Kalender: Freigabe</option>
        <option value="auto">Kalender: Auto</option>
      </select>
    </label>
  );
}

export function TopBar({
  showJobs,
  showTasks,
  showPeople,
  showHome,
  openRecording,
  currentTopic,
  showRecordingIndicator,
  onTopicExport,
}: {
  showJobs: boolean;
  showTasks: boolean;
  showPeople: boolean;
  showHome: boolean;
  openRecording: Recording | null;
  currentTopic: Topic | undefined;
  showRecordingIndicator: boolean;
  onTopicExport: () => void;
}) {
  const title = showJobs
    ? "Verarbeitung"
    : showTasks
      ? "Aufgaben"
      : showPeople
        ? "Personen"
        : showHome
          ? "Arbeitsbereich"
          : openRecording
            ? currentTopic?.name ?? "Aufnahme"
            : currentTopic
              ? "Bibliothek"
              : "Tarscribe";

  return (
    <div className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
      </div>
      <div className="spacer" />
      {showRecordingIndicator && <GlobalRecordingIndicator />}
      {currentTopic && !showHome && !showTasks && !showPeople && !showJobs && (
        <>
          <button
            className="btn ghost"
            title={
              currentTopic.export_path
                ? `Export-Ordner: ${currentTopic.export_path}`
                : "Export-Ordner festlegen"
            }
            onClick={onTopicExport}
          >
            <FolderIcon width={16} height={16} />
            {currentTopic.export_path ? "Export bereit" : "Export-Ordner"}
          </button>
          <TopicCalendarControl topic={currentTopic} />
        </>
      )}
    </div>
  );
}
