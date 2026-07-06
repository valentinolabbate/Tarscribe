import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AudioPlayer, type PlayerHandle } from "./AudioPlayer";
import {
  useDiarization,
  useDiarize,
  useSpeakerEdits,
  useLatestJob,
  useRetryJob,
  useSummaries,
  useTranscribe,
  useTranscript,
  useUpdateRecording,
} from "../hooks/queries";
import { preferJobEvent, useJobFor } from "../hooks/useJobs";
import { api } from "../lib/api";
import type { Recording, Topic } from "../lib/types";
import { useToast } from "./Toast";
import { ChaptersBar } from "./ChaptersBar";
import { AskWorkspace } from "./recording-detail/AskWorkspace";
import { DetailEmptyState } from "./recording-detail/DetailEmptyState";
import { DetailTabs } from "./recording-detail/DetailTabs";
import { JobErrorBanners } from "./recording-detail/JobErrorBanners";
import { RecordingFlowTimeline } from "./recording-detail/RecordingFlowTimeline";
import { RecordingToolbar } from "./recording-detail/RecordingToolbar";
import { SpeakersWorkspace } from "./recording-detail/SpeakersWorkspace";
import { SummaryWorkspace } from "./recording-detail/SummaryWorkspace";
import { TranscriptPanel } from "./recording-detail/TranscriptPanel";
import { groupWordsIntoSentences, type DetailTab } from "./recording-detail/model";
import { useRecordingFlowSteps } from "./recording-detail/useRecordingFlowSteps";
export function RecordingDetail({
  recording,
  topics,
  onBack,
  onMoved,
  onOpenSettings,
}: {
  recording: Recording;
  topics: Topic[];
  onBack: () => void;
  onMoved?: (recording: Recording) => void;
  onOpenSettings?: () => void;
}) {
  const job = useJobFor(recording.id);
  const transcribe = useTranscribe();
  const diarizeFirst = useDiarize();
  const retry = useRetryJob(recording.id);
  const { reassign } = useSpeakerEdits(recording.id);
  const updateRec = useUpdateRecording();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isFullyReady = recording.status === "ready";
  const isTranscribed = isFullyReady || recording.status === "diarizing";
  const statusRunning = recording.status === "transcribing" || recording.status === "diarizing";
  const { data: transcript, isLoading: transcriptLoading } = useTranscript(recording.id, isTranscribed);
  const { data: diar } = useDiarization(recording.id, isTranscribed && !!transcript);
  const { data: summaries } = useSummaries(recording.id, isTranscribed && !!transcript);
  const transcriptPending = isTranscribed && transcriptLoading;
  const [showTuning, setShowTuning] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("transcript");
  const [exportOpen, setExportOpen] = useState(false);
  const playerRef = useRef<PlayerHandle>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);
  const sentences = useMemo(
    () => (transcript && !diar ? groupWordsIntoSentences(transcript.words) : []),
    [transcript, diar],
  );
  const activeStart =
    (diar
      ? diar.utterances.find((u) => currentTime >= u.start && currentTime < u.end)
      : sentences.find((s) => currentTime >= s.start && currentTime < s.end)
    )?.start ?? -1;
  useEffect(() => {
    if (activeTab === "transcript" && playing && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeStart, activeTab, playing]);

  const localRunning = job?.status === "running" || job?.status === "pending";
  const { data: polledJob } = useLatestJob(recording.id, localRunning || statusRunning);
  const activeJob = preferJobEvent(job, polledJob);
  const running =
    activeJob?.status === "running" || activeJob?.status === "pending" || statusRunning;

  const startingPhase = transcribe.isPending
    ? "Starte Transkription"
    : diarizeFirst.isPending
      ? "Starte Sprechererkennung"
      : null;
  const labels = diar?.speakers.map((s) => s.label) ?? [];
  const summaryCount = summaries?.filter((summary) => summary.content).length ?? 0;
  const wordCount = transcript?.words.length ?? 0;
  const wordLabel = `${wordCount} ${wordCount === 1 ? "Wort" : "Wörter"}`;
  const transcriptMeta = diar
    ? `${diar.utterances.length} ${diar.utterances.length === 1 ? "Abschnitt" : "Abschnitte"}`
    : transcript
      ? `${sentences.length} ${sentences.length === 1 ? "Abschnitt" : "Abschnitte"} · ${wordLabel}`
      : "";

  const tabs = useMemo(
    () => [
      { id: "transcript" as const, label: "Transkript", meta: transcript ? wordLabel : "" },
      {
        id: "summary" as const,
        label: "Zusammenfassung",
        meta: summaryCount > 0 ? `${summaryCount}` : "",
      },
      { id: "ask" as const, label: "Fragen", meta: "" },
      {
        id: "speakers" as const,
        label: "Sprecher",
        meta: diar ? `${diar.speakers.length}` : "",
      },
    ],
    [diar, summaryCount, transcriptMeta],
  );

  async function exportRecording(format: string) {
    setExportOpen(false);
    try {
      await api.downloadExport(recording.id, format, recording.title);
      await queryClient.invalidateQueries({ queryKey: ["topics"] });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function sendToFolder() {
    setExportOpen(false);
    try {
      const res = await api.sendToFolder(recording.id);
      toast(`Gesendet: ${res.path}`, "success");
      await queryClient.invalidateQueries({ queryKey: ["topics"] });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function moveRecording(topicId: number) {
    if (topicId === recording.topic_id) return;
    const target = topics.find((topic) => topic.id === topicId);
    try {
      const updated = await updateRec.mutateAsync({
        id: recording.id,
        patch: { topic_id: topicId },
      });
      toast(`Verschoben nach ${target?.name ?? "neuen Bereich"}`, "success");
      onMoved?.(updated);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function startTranscription(replaceExisting: boolean) {
    if (
      replaceExisting &&
      transcript &&
      !window.confirm("Transkript nochmal neu erstellen? Das aktuelle Transkript wird ersetzt.")
    ) {
      return;
    }
    setActiveTab("transcript");
    try {
      await transcribe.mutateAsync({ id: recording.id });
      toast(replaceExisting ? "Transkription neu gestartet" : "Transkription gestartet", "info");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const flowSteps = useRecordingFlowSteps({
    recording,
    activeJob,
    startingPhase,
    transcribePending: transcribe.isPending,
    diarizePending: diarizeFirst.isPending,
    running: !!running,
    transcript,
    diar,
    summaryCount,
    onStartTranscription: (replaceExisting) => void startTranscription(replaceExisting),
    onStartDiarization: () => {
      setActiveTab("speakers");
      diarizeFirst.mutate({ id: recording.id });
    },
    onOpenSummary: () => setActiveTab("summary"),
  });

  return (
    <div className="detail">
      <RecordingToolbar
        recording={recording}
        topics={topics}
        transcript={transcript}
        diar={diar}
        isTranscribed={isTranscribed}
        updatePending={updateRec.isPending}
        diarizePending={diarizeFirst.isPending}
        running={!!running}
        transcribePending={transcribe.isPending}
        exportOpen={exportOpen}
        onBack={onBack}
        onRename={(title) => updateRec.mutate({ id: recording.id, patch: { title } })}
        onMoveRecording={(topicId) => void moveRecording(topicId)}
        onDetectSpeakers={() => {
          setActiveTab("speakers");
          diarizeFirst.mutate({ id: recording.id });
        }}
        onRetranscribe={() => void startTranscription(true)}
        onToggleExport={() => setExportOpen((value) => !value)}
        onCloseExport={() => setExportOpen(false)}
        onExport={(format) => void exportRecording(format)}
        onDownloadAudio={() => {
          api.downloadAudio(recording.id, recording.title);
          setExportOpen(false);
        }}
        onSendToFolder={() => void sendToFolder()}
      />

      <RecordingFlowTimeline steps={flowSteps} />

      <JobErrorBanners
        activeJob={activeJob}
        running={!!running}
        retryPending={retry.isPending}
        transcribePending={transcribe.isPending}
        hasTranscript={!!transcript}
        onRetry={(jobId) => retry.mutate(jobId)}
        onRetranscribe={() => void startTranscription(true)}
      />

      {!transcript && !transcriptPending && (
        <DetailEmptyState
          running={!!running}
          startingPhase={startingPhase}
          transcribePending={transcribe.isPending}
          error={activeJob?.status === "failed" ? activeJob.error : null}
          onTranscribe={() => void startTranscription(false)}
        />
      )}

      {transcript && (
        <>
          <AudioPlayer
            ref={playerRef}
            recordingId={recording.id}
            audioPath={recording.audio_path}
            durationSec={recording.duration_sec}
            onTime={setCurrentTime}
            onPlaying={setPlaying}
          />
          <ChaptersBar
            recordingId={recording.id}
            recordingTitle={recording.title}
            durationSec={recording.duration_sec}
            currentTime={currentTime}
            onSeek={(sec) => playerRef.current?.seek(sec)}
          />
          <DetailTabs tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} />
          <div className="detail-workspace">
            {activeTab === "transcript" && (
              <TranscriptPanel
                transcript={transcript}
                diar={diar}
                transcriptMeta={transcriptMeta}
                sentences={sentences}
                currentTime={currentTime}
                labels={labels}
                activeRef={activeRef}
                playerRef={playerRef}
                reassign={reassign}
                onOpenSpeakers={() => setActiveTab("speakers")}
              />
            )}

            {activeTab === "summary" && (
              <SummaryWorkspace
                recordingId={recording.id}
                recordingTitle={recording.title}
                onOpenSettings={onOpenSettings}
              />
            )}

            {activeTab === "ask" && (
              <AskWorkspace topics={topics} recording={recording} playerRef={playerRef} />
            )}

            {activeTab === "speakers" && (
              <SpeakersWorkspace
                recordingId={recording.id}
                diar={diar}
                labels={labels}
                showTuning={showTuning}
                running={!!running}
                diarizePending={diarizeFirst.isPending}
                onToggleTuning={() => setShowTuning((value) => !value)}
                onDiarize={() => diarizeFirst.mutate({ id: recording.id })}
                playerRef={playerRef}
                currentTime={currentTime}
                playing={playing}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
