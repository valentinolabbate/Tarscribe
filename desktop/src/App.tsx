import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { DictationOverlay } from "./components/DictationOverlay";
import { SetupScreen } from "./components/SetupScreen";
import { SettingsModal } from "./components/SettingsModal";
import { TopicModal } from "./components/TopicModal";
import { UpdateModal } from "./components/UpdateModal";
import { useToast } from "./components/Toast";
import { checkForUpdate, type PendingUpdate } from "./lib/updater";
import { TopicExportModal } from "./components/TopicExportModal";
import { Splash } from "./components/Splash";
import { AppContent } from "./components/layout/AppContent";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { useSidebarWidth } from "./components/layout/LayoutProvider";
import { useRecordings, useReorderTopics, useTopics } from "./hooks/queries";
import { useJobSocket } from "./hooks/useJobs";
import { useDictation } from "./hooks/useDictation";
import { useRecording } from "./hooks/useRecording";
import { useAppBootstrap } from "./hooks/useAppBootstrap";
import { useAppSettingsBootstrap } from "./hooks/useAppSettingsBootstrap";
import { useDetectedMeetingStarter, useNativeAppEvents } from "./hooks/useNativeAppEvents";
import { api } from "./lib/api";
import { setTrayRecordingState } from "./lib/tauri";
import type { Recording, Topic } from "./lib/types";

export default function App() {
  const { ready, error, needsSetup, setNeedsSetup, needsEnv, setNeedsEnv, proceed } =
    useAppBootstrap();
  const [activeTopic, setActiveTopic] = useState<number | null>(null);
  const [openRecording, setOpenRecording] = useState<Recording | null>(null);
  const [showTopicModal, setShowTopicModal] = useState(false);
  const [showHome, setShowHome] = useState(true);
  const [showTasks, setShowTasks] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [openRecordingStartSec, setOpenRecordingStartSec] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTopicExport, setShowTopicExport] = useState(false);
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const [detectedMeeting, setDetectedMeeting] = useState<{ appName: string } | null>(null);
  const queryClient = useQueryClient();
  const { sidebarWidth, handleResizerDown } = useSidebarWidth();

  const { data: topics } = useTopics();
  const reorderTopics = useReorderTopics();

  const moveTopic = useCallback(
    (id: number, direction: -1 | 1) => {
      const list = topics ?? [];
      const from = list.findIndex((t) => t.id === id);
      if (from === -1) return;
      const to = from + direction;
      if (to < 0 || to >= list.length) return;
      const next = list.slice();
      [next[from], next[to]] = [next[to], next[from]];
      reorderTopics.mutate(next.map((t) => t.id));
    },
    [topics, reorderTopics],
  );

  const { data: liveRecordings } = useRecordings(activeTopic ?? undefined);
  const toast = useToast();
  const recording = useRecording();
  const currentTopicRef = useRef<Topic | null>(null);
  const recordingRef = useRef(recording);
  useJobSocket(recording.dispatchLiveEvent);
  const current = topics?.find((t) => t.id === activeTopic);

  useEffect(() => {
    currentTopicRef.current = current ?? null;
  }, [current]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    setTrayRecordingState({
      state: recording.state,
      elapsed: recording.elapsed,
      topicName: recording.topicName ?? current?.name ?? null,
      canStart: recording.state === "idle" && !!current,
    }).catch(() => {});
  }, [current, recording.elapsed, recording.state, recording.topicName]);

  useEffect(() => {
    if (!openRecording || !liveRecordings) return;
    const live = liveRecordings.find((r) => r.id === openRecording.id);
    if (live && live.status !== openRecording.status) setOpenRecording(live);
  }, [liveRecordings, openRecording]);

  useEffect(() => {
    if (!recording.lastFinishedRecording) return;
    const rec = recording.lastFinishedRecording;
    recording.clearLastFinished();
    setActiveTopic(rec.topic_id);
    setShowHome(false);
    setShowTasks(false);
    setShowPeople(false);
    setShowJobs(false);
    setOpenRecordingStartSec(null);
    setOpenRecording(rec);
  }, [recording.lastFinishedRecording, recording.clearLastFinished]);

  useEffect(() => {
    if (recording.state === "idle") return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (recording.state === "recording") recording.pause();
        else if (recording.state === "paused") recording.resume();
      }
      if (e.code === "Escape" && (recording.state === "recording" || recording.state === "paused")) {
        recording.stop();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  useEffect(() => {
    checkForUpdate()
      .then((u) => {
        if (u) {
          setUpdate(u);
          setShowUpdate(true);
        }
      })
      .catch(() => {});
  }, []);

  const openRecordingById = useCallback(async (recordingId: number, startSec?: number | null) => {
    try {
      const rec = await api.getRecording(recordingId);
      setActiveTopic(rec.topic_id);
      setShowHome(false);
      setShowTasks(false);
      setShowPeople(false);
      setShowJobs(false);
      setOpenRecordingStartSec(startSec ?? null);
      setOpenRecording(rec);
    } catch {
      toast("Aufnahme konnte nicht geöffnet werden.", "error");
    }
  }, [toast]);
  const dictation = useDictation(openRecordingById);
  const dictationRef = useRef(dictation);

  useEffect(() => {
    dictationRef.current = dictation;
  }, [dictation]);

  const dictationShortcutLabel = useAppSettingsBootstrap({ ready, needsSetup, needsEnv, toast });
  const startDetectedMeeting = useDetectedMeetingStarter({
    topics,
    queryClient,
    recordingRef,
    setActiveTopic,
    setShowHome,
    setShowTasks,
    setShowPeople,
    setShowJobs,
    setOpenRecording,
    setDetectedMeeting,
    toast,
  });
  useNativeAppEvents({
    currentTopicRef,
    recordingRef,
    dictationRef,
    setShowSettings,
    setShowTopicModal,
    setUpdate,
    setShowUpdate,
    setDetectedMeeting,
    toast,
  });

  useEffect(() => {
    if (topics && !topics.some((topic) => topic.id === activeTopic)) {
      setActiveTopic(topics[0]?.id ?? null);
      setOpenRecording(null);
    }
  }, [topics, activeTopic]);

  if (needsEnv)
    return (
      <SetupScreen
        onReady={() => {
          setNeedsEnv(false);
          proceed();
        }}
      />
    );
  if (!ready) return <Splash error={error} />;
  if (needsSetup) return <FirstRunWizard onDone={() => setNeedsSetup(false)} />;

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <Sidebar
        topics={topics ?? []}
        activeTopic={activeTopic}
        showHome={showHome}
        showTasks={showTasks}
        showPeople={showPeople}
        showJobs={showJobs}
        onHome={() => {
          setShowHome(true);
          setShowTasks(false);
          setShowPeople(false);
          setShowJobs(false);
          setOpenRecordingStartSec(null);
          setOpenRecording(null);
        }}
        onTasks={() => {
          setShowTasks(true);
          setShowHome(false);
          setShowPeople(false);
          setShowJobs(false);
          setOpenRecordingStartSec(null);
          setOpenRecording(null);
        }}
        onPeople={() => {
          setShowPeople(true);
          setShowTasks(false);
          setShowHome(false);
          setShowJobs(false);
          setOpenRecordingStartSec(null);
          setOpenRecording(null);
        }}
        onJobs={() => {
          setShowJobs(true);
          setShowTasks(false);
          setShowPeople(false);
          setShowHome(false);
          setOpenRecordingStartSec(null);
          setOpenRecording(null);
        }}
        onNewTopic={() => setShowTopicModal(true)}
        onSelectTopic={(topicId) => {
          setActiveTopic(topicId);
          setOpenRecording(null);
          setShowHome(false);
          setShowTasks(false);
          setShowPeople(false);
          setShowJobs(false);
          setOpenRecordingStartSec(null);
        }}
        onMoveTopic={moveTopic}
        onSettings={() => setShowSettings(true)}
      />

      <div className="resizer" onMouseDown={handleResizerDown} />

      <main className="main">
        <TopBar
          showJobs={showJobs}
          showTasks={showTasks}
          showPeople={showPeople}
          showHome={showHome}
          openRecording={openRecording}
          currentTopic={current}
          showRecordingIndicator={recording.state === "idle"}
          onTopicExport={() => setShowTopicExport(true)}
        />
        <div className="content">
          <AppContent
            recording={recording}
            dictation={dictation}
            topics={topics ?? []}
            currentTopic={current}
            showJobs={showJobs}
            showTasks={showTasks}
            showPeople={showPeople}
            showHome={showHome}
            openRecording={openRecording}
            openRecordingStartSec={openRecordingStartSec}
            dictationShortcutLabel={dictationShortcutLabel}
            onOpenRecording={openRecordingById}
            onBackFromRecording={() => {
              setOpenRecordingStartSec(null);
              setOpenRecording(null);
            }}
            onMovedRecording={(rec) => {
              setActiveTopic(rec.topic_id);
              setOpenRecordingStartSec(null);
              setOpenRecording(rec);
            }}
            onOpenSettings={() => setShowSettings(true)}
            onSetOpenRecording={(rec) => {
              setOpenRecordingStartSec(null);
              setOpenRecording(rec);
            }}
          />
        </div>
      </main>

      <DictationOverlay dictation={dictation} />
      {detectedMeeting && (
        <div className="meeting-prompt" role="dialog" aria-label="Meeting erkannt">
          <div>
            <strong>Meeting erkannt</strong>
            <span>{detectedMeeting.appName} nutzt gerade das Mikrofon. Aufnahme starten?</span>
          </div>
          <button className="btn ghost" onClick={() => setDetectedMeeting(null)}>
            Ignorieren
          </button>
          <button className="btn primary" onClick={startDetectedMeeting}>
            Aufnehmen
          </button>
        </div>
      )}
      {showTopicModal && <TopicModal onClose={() => setShowTopicModal(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showTopicExport && current && (
        <TopicExportModal topic={current} onClose={() => setShowTopicExport(false)} />
      )}
      {showUpdate && update && (
        <UpdateModal pending={update} onClose={() => setShowUpdate(false)} />
      )}
    </div>
  );
}
