import { useHardware, useUpdateTopic } from "../../hooks/queries";
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

function HardwarePill() {
  const { data: hardware } = useHardware();
  if (!hardware) return null;
  const device = hardware.has_cuda
    ? `CUDA · ${hardware.cuda_device ?? "GPU"}`
    : hardware.is_apple_silicon
      ? `Apple Silicon · Diarisierung: ${hardware.has_mps ? "MPS" : "CPU"}`
      : "CPU";
  return (
    <span className="hw-pill" title={`${device} · ASR: ${hardware.recommended_asr}`}>
      <span className="hw-dot" />
      Lokal bereit
    </span>
  );
}

export function TopBar({
  showJobs,
  showTasks,
  showHome,
  openRecording,
  currentTopic,
  showRecordingIndicator,
  onTopicExport,
}: {
  showJobs: boolean;
  showTasks: boolean;
  showHome: boolean;
  openRecording: Recording | null;
  currentTopic: Topic | undefined;
  showRecordingIndicator: boolean;
  onTopicExport: () => void;
}) {
  const eyebrow = showJobs
    ? "Debug"
    : showTasks
      ? "Aufgaben"
      : showHome
        ? "Start"
        : openRecording
          ? "Aufnahme"
          : "Themenbereich";
  const title = showJobs
    ? "Jobs"
    : showTasks
      ? "Aufgaben-Zentrale"
      : showHome
        ? "Tarscribe"
        : openRecording
          ? openRecording.title
          : currentTopic
            ? currentTopic.name
            : "Tarscribe";

  return (
    <div className="topbar">
      <div className="topbar-title">
        <span className="topbar-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <div className="spacer" />
      {showRecordingIndicator && <GlobalRecordingIndicator />}
      {currentTopic && !showHome && !showTasks && !showJobs && (
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
      <HardwarePill />
    </div>
  );
}
