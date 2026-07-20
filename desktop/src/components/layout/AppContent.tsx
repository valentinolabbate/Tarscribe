import type { useDictation } from "../../hooks/useDictation";
import type { useRecording } from "../../hooks/useRecording";
import type { ActionItem, Recording, Topic } from "../../lib/types";
import { JobsPage } from "../JobsPage";
import { LiveRecordingDetail } from "../LiveRecordingDetail";
import { RecordingDetail } from "../RecordingDetail";
import { RecordingList } from "../RecordingList";
import { PeoplePage } from "../PeoplePage";
import { MemoryPage } from "../MemoryPage";
import { StartPage } from "../StartPage";
import { TasksPage } from "../TasksPage";
import {
  MemorySectionNav,
  type MemoryContentView,
  type MemorySection,
} from "../MemorySectionNav";

export function AppContent({
  recording,
  dictation,
  topics,
  currentTopic,
  showJobs,
  showTasks,
  showMemory,
  showPeople,
  memoryView,
  focusedMemoryItemId,
  showHome,
  openRecording,
  openRecordingStartSec,
  dictationShortcutLabel,
  onOpenRecording,
  onOpenDocument,
  onMemorySection,
  onOpenMemoryItem,
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
  memoryView: MemoryContentView;
  focusedMemoryItemId: number | null;
  showHome: boolean;
  openRecording: Recording | null;
  openRecordingStartSec: number | null;
  dictationShortcutLabel: string;
  onOpenRecording: (recordingId: number, startSec?: number | null) => Promise<void>;
  onOpenDocument: (documentId: number) => void;
  onMemorySection: (section: MemorySection) => void;
  onOpenMemoryItem: (item: ActionItem) => void;
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
        showLiveSpeakers={recording.liveDiarizationEnabled}
        finalTranscriptionJob={recording.finalTranscriptionJob}
        onPause={recording.pause}
        onResume={recording.resume}
        onStop={recording.stop}
      />
    );
  }

  if (showJobs) return <JobsPage onOpenRecording={onOpenRecording} />;
  if (showTasks || showMemory || showPeople) {
    const activeSection: MemorySection = showTasks ? "tasks" : showPeople ? "people" : memoryView;
    return (
      <div className="page-shell memory-workspace">
        <MemorySectionNav active={activeSection} onSelect={onMemorySection} />
        {showTasks && (
          <TasksPage
            topics={topics}
            onOpenRecording={onOpenRecording}
            focusedItemId={focusedMemoryItemId}
          />
        )}
        {showMemory && (
          <MemoryPage
            topics={topics}
            view={memoryView}
            onOpenRecording={onOpenRecording}
            focusedItemId={focusedMemoryItemId}
          />
        )}
        {showPeople && <PeoplePage onOpenRecording={onOpenRecording} />}
      </div>
    );
  }
  if (showHome) {
    return (
      <StartPage
        topics={topics}
        onOpenSource={onOpenRecording}
        onOpenMemoryItem={onOpenMemoryItem}
        onOpenDocument={onOpenDocument}
        dictation={dictation}
        dictationShortcutLabel={dictationShortcutLabel}
      />
    );
  }
  if (openRecording) {
    return (
      <RecordingDetail
        key={openRecording.id}
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
      onOpenMemoryItem={onOpenMemoryItem}
      onOpenDocument={onOpenDocument}
      dictation={dictation}
      dictationShortcutLabel={dictationShortcutLabel}
    />
  );
}
