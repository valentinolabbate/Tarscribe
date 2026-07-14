import type { useDictation } from "../../hooks/useDictation";
import type { useRecording } from "../../hooks/useRecording";
import type { Recording, Topic } from "../../lib/types";
import { JobsPage } from "../JobsPage";
import { LiveRecordingDetail } from "../LiveRecordingDetail";
import { RecordingDetail } from "../RecordingDetail";
import { RecordingList } from "../RecordingList";
import { PeoplePage } from "../PeoplePage";
import { MemoryPage } from "../MemoryPage";
import { StartPage } from "../StartPage";
import { TasksPage } from "../TasksPage";

export function AppContent({
  recording,
  dictation,
  topics,
  currentTopic,
  showJobs,
  showTasks,
  showMemory,
  showPeople,
  showHome,
  openRecording,
  openRecordingStartSec,
  dictationShortcutLabel,
  onOpenRecording,
  onOpenDocument,
  onBackFromRecording,
  onMovedRecording,
  onOpenSettings,
  onSetOpenRecording,
}: {
  recording: ReturnType<typeof useRecording>;
  dictation: ReturnType<typeof useDictation>;
  topics: Topic[];
  currentTopic: Topic | undefined;
  showJobs: boolean;
  showTasks: boolean;
  showMemory: boolean;
  showPeople: boolean;
  showHome: boolean;
  openRecording: Recording | null;
  openRecordingStartSec: number | null;
  dictationShortcutLabel: string;
  onOpenRecording: (recordingId: number, startSec?: number | null) => Promise<void>;
  onOpenDocument: (documentId: number) => void;
  onBackFromRecording: () => void;
  onMovedRecording: (recording: Recording) => void;
  onOpenSettings: () => void;
  onSetOpenRecording: (recording: Recording) => void;
}) {
  if (recording.state !== "idle") {
    return (
      <LiveRecordingDetail
        topicName={recording.topicName ?? "Aufnahme"}
        elapsed={recording.elapsed}
        state={recording.state}
        handle={recording.liveHandle}
        finalTranscriptionJob={recording.finalTranscriptionJob}
        onPause={recording.pause}
        onResume={recording.resume}
        onStop={recording.stop}
      />
    );
  }

  if (showJobs) return <JobsPage onOpenRecording={onOpenRecording} />;
  if (showTasks) return <TasksPage topics={topics} onOpenRecording={onOpenRecording} />;
  if (showMemory) return <MemoryPage topics={topics} onOpenRecording={onOpenRecording} />;
  if (showPeople) return <PeoplePage onOpenRecording={onOpenRecording} />;
  if (showHome) {
    return (
      <StartPage
        topics={topics}
        onOpenSource={onOpenRecording}
        onOpenDocument={onOpenDocument}
        dictation={dictation}
        dictationShortcutLabel={dictationShortcutLabel}
      />
    );
  }
  if (openRecording) {
    return (
      <RecordingDetail
        recording={openRecording}
        topics={topics}
        onBack={onBackFromRecording}
        onMoved={onMovedRecording}
        onOpenSettings={onOpenSettings}
        onOpenDocument={onOpenDocument}
        onOpenRecording={onOpenRecording}
        initialSeekSec={openRecordingStartSec}
      />
    );
  }
  if (currentTopic) {
    return (
      <RecordingList
        topic={currentTopic}
        onOpen={onSetOpenRecording}
        onOpenDocument={onOpenDocument}
      />
    );
  }
  return (
    <StartPage
      topics={topics}
      onOpenSource={onOpenRecording}
      onOpenDocument={onOpenDocument}
      dictation={dictation}
      dictationShortcutLabel={dictationShortcutLabel}
    />
  );
}
