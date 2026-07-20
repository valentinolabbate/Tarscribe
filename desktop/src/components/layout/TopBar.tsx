import { useUpdateTopic } from "../../hooks/queries";
import type { Recording, Topic } from "../../lib/types";
import { GlobalRecordingIndicator } from "../GlobalRecordingIndicator";
import { CalendarIcon, FolderIcon, MenuIcon } from "../icons";

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
  showMemory,
  showPeople,
  showHome,
  openRecording,
  currentTopic,
  showRecordingIndicator,
  onTopicExport,
  navigationOpen = false,
  onToggleNavigation,
}: {
  showJobs: boolean;
  showTasks: boolean;
  showMemory: boolean;
  showPeople: boolean;
  showHome: boolean;
  openRecording: Recording | null;
  currentTopic: Topic | undefined;
  showRecordingIndicator: boolean;
  onTopicExport: () => void;
  navigationOpen?: boolean;
  onToggleNavigation?: () => void;
}) {
  const showMemorySection = showMemory || showTasks || showPeople;
  const title = showJobs
    ? "Verarbeitung"
    : showMemorySection
      ? "Gedächtnis"
        : showHome
          ? "Arbeitsbereich"
          : openRecording
            ? currentTopic?.name ?? "Aufnahme"
            : currentTopic
              ? "Bibliothek"
              : "Tarscribe";

  return (
    <div className="topbar">
      {onToggleNavigation && (
        <button
          type="button"
          className="compact-nav-trigger"
          aria-label={navigationOpen ? "Navigation schließen" : "Navigation öffnen"}
          aria-expanded={navigationOpen}
          onClick={onToggleNavigation}
        >
          <MenuIcon width={18} height={18} />
        </button>
      )}
      <div className="topbar-title">
        <h1>{title}</h1>
      </div>
      <div className="spacer" />
      {showRecordingIndicator && <GlobalRecordingIndicator />}
      {currentTopic && !showHome && !showTasks && !showMemory && !showPeople && !showJobs && (
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
