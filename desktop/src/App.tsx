import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { StartPage } from "./components/StartPage";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { DictationOverlay } from "./components/DictationOverlay";
import { GlobalRecordingIndicator } from "./components/GlobalRecordingIndicator";
import { JobsPage } from "./components/JobsPage";
import { LiveRecordingDetail } from "./components/LiveRecordingDetail";
import { SetupScreen } from "./components/SetupScreen";
import { RecordingDetail } from "./components/RecordingDetail";
import { RecordingList } from "./components/RecordingList";
import { SettingsModal } from "./components/SettingsModal";
import { TopicModal } from "./components/TopicModal";
import { UpdateModal } from "./components/UpdateModal";
import { useToast } from "./components/Toast";
import { checkForUpdate, type PendingUpdate } from "./lib/updater";
import { ActivityIcon, CalendarIcon, ChevronDownIcon, ChevronUpIcon, FolderIcon, HomeIcon, LogoIcon, PlusIcon, SettingsIcon, TasksIcon, TrashIcon } from "./components/icons";
import { TasksPage } from "./components/TasksPage";
import { TopicExportModal } from "./components/TopicExportModal";
import {
  useDeleteTopic,
  useHardware,
  useRecordings,
  useReorderTopics,
  useTopics,
  useUpdateTopic,
} from "./hooks/queries";
import { useJobSocket } from "./hooks/useJobs";
import { useDictation } from "./hooks/useDictation";
import { useRecording } from "./hooks/useRecording";
import { api, waitForBackend } from "./lib/api";
import { invoke, isTauri, setTrayRecordingState } from "./lib/tauri";
import type { Recording, Topic } from "./lib/types";

const clampSidebarWidth = (width: number) =>
  Math.max(224, Math.min(320, window.innerWidth - 720, Number.isFinite(width) ? width : 264));

function shortcutLabel(accelerator: string): string {
  const symbols: Record<string, string> = {
    alt: "⌥",
    option: "⌥",
    opt: "⌥",
    meta: "⌘",
    cmd: "⌘",
    command: "⌘",
    super: "⌘",
    ctrl: "⌃",
    control: "⌃",
    shift: "⇧",
  };
  return accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => symbols[part.toLowerCase()] ?? part.toUpperCase())
    .join("");
}

function Splash({ error }: { error?: string }) {
  return (
    <div className="splash">
      {error ? (
        <>
          <div className="big" style={{ color: "var(--danger)" }}>
            Backend nicht erreichbar
          </div>
          <div style={{ maxWidth: 360, textAlign: "center" }}>{error}</div>
        </>
      ) : (
        <>
          <div className="spinner" />
          <div>Tarscribe wird gestartet…</div>
        </>
      )}
    </div>
  );
}

function TopicRow({
  topic,
  active,
  canMoveUp,
  canMoveDown,
  onSelect,
  onMoveUp,
  onMoveDown,
}: {
  topic: Topic;
  active: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateTopic();
  const del = useDeleteTopic();
  const recording = useRecording();
  const artifactBadges = [
    {
      key: "transcribed",
      label: "T",
      count: topic.transcribed_count,
      title: `${topic.transcribed_count} transkribiert`,
    },
    {
      key: "diarized",
      label: "D",
      count: topic.diarized_count,
      title: `${topic.diarized_count} mit Sprechererkennung`,
    },
    {
      key: "exported",
      label: "E",
      count: topic.exported_count,
      title: `${topic.exported_count} exportiert`,
    },
  ].filter((item) => item.count > 0);

  if (editing) {
    return (
      <input
        className="topic-edit"
        defaultValue={topic.name}
        autoFocus
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== topic.name) update.mutate({ id: topic.id, patch: { name: v } });
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <div
      className={`topic-item topic-row ${active ? "active" : ""}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      title="Doppelklick zum Umbenennen"
    >
      <span className="topic-dot" style={{ background: topic.color }} />
      <span className="topic-name">{topic.name}</span>
      {artifactBadges.length > 0 && (
        <span className="topic-artifacts" aria-label="Verarbeitungsstatus">
          {artifactBadges.map((item) => (
            <span key={item.key} className={`topic-artifact ${item.key}`} title={item.title}>
              {item.label}{item.count}
            </span>
          ))}
        </span>
      )}
      <span className="topic-actions">
        <span className="topic-reorder" aria-label="Sortieren">
          <button
            className="topic-move"
            title="Nach oben"
            aria-label="Nach oben verschieben"
            disabled={!canMoveUp}
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp();
            }}
          >
            <ChevronUpIcon width={13} height={13} />
          </button>
          <button
            className="topic-move"
            title="Nach unten"
            aria-label="Nach unten verschieben"
            disabled={!canMoveDown}
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown();
            }}
          >
            <ChevronDownIcon width={13} height={13} />
          </button>
        </span>
        <button
          className="topic-del"
          title={
            recording.topicId === topic.id
              ? "Während einer laufenden Aufnahme nicht löschbar"
              : "Themenbereich löschen"
          }
          disabled={recording.topicId === topic.id}
          onClick={(e) => {
            e.stopPropagation();
            del.mutate(topic.id);
          }}
        >
          <TrashIcon width={13} height={13} />
        </button>
      </span>
    </div>
  );
}

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
        onChange={(e) => {
          update.mutate({
            id: topic.id,
            patch: { calendar_export_mode: e.target.value as Topic["calendar_export_mode"] },
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
  const { data: hw } = useHardware();
  if (!hw) return null;
  const dev = hw.has_cuda
    ? `CUDA · ${hw.cuda_device ?? "GPU"}`
    : hw.is_apple_silicon
      ? `Apple Silicon · Diarisierung: ${hw.has_mps ? "MPS" : "CPU"}`
      : "CPU";
  return (
    <span className="hw-pill" title={`${dev} · ASR: ${hw.recommended_asr}`}>
      <span className="hw-dot" />
      Lokal bereit
    </span>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [needsEnv, setNeedsEnv] = useState(false);
  const [activeTopic, setActiveTopic] = useState<number | null>(null);
  const [openRecording, setOpenRecording] = useState<Recording | null>(null);
  const [showTopicModal, setShowTopicModal] = useState(false);
  const [showHome, setShowHome] = useState(true);
  const [showTasks, setShowTasks] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTopicExport, setShowTopicExport] = useState(false);
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const [dictationShortcutLabel, setDictationShortcutLabel] = useState("⌥⌘D");
  const [detectedMeeting, setDetectedMeeting] = useState<{ appName: string } | null>(null);
  const queryClient = useQueryClient();

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const v = localStorage.getItem("ts-sidebar-w");
      return clampSidebarWidth(v ? Number(v) : 264);
    } catch { return 264; }
  });

  const handleResizerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => setSidebarWidth(clampSidebarWidth(startW + ev.clientX - startX));
    const onUp = (ev: MouseEvent) => {
      const w = clampSidebarWidth(startW + ev.clientX - startX);
      setSidebarWidth(w);
      try { localStorage.setItem("ts-sidebar-w", String(w)); } catch { /* ignore */ }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  useEffect(() => {
    const onResize = () => setSidebarWidth((width) => clampSidebarWidth(width));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const { data: topics } = useTopics();
  const reorderTopics = useReorderTopics();

  // Reorder via per-row up/down buttons. We swap the topic with its neighbour and
  // commit the new id order; useReorderTopics optimistically reorders the cached
  // list, so the sidebar updates instantly without local copy bookkeeping.
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

  // Keep openRecording in sync with live query data so status changes
  // (e.g. diarizing → ready) are reflected without navigating away.
  useEffect(() => {
    if (!openRecording || !liveRecordings) return;
    const live = liveRecordings.find((r) => r.id === openRecording.id);
    if (live && live.status !== openRecording.status) setOpenRecording(live);
  }, [liveRecordings, openRecording]);

  // After a live recording finishes, automatically open the new recording's detail page.
  useEffect(() => {
    if (!recording.lastFinishedRecording) return;
    const rec = recording.lastFinishedRecording;
    recording.clearLastFinished();
    setActiveTopic(rec.topic_id);
    setShowHome(false);
    setShowTasks(false);
    setShowJobs(false);
    setOpenRecording(rec);
  }, [recording.lastFinishedRecording, recording.clearLastFinished]);

  // Keyboard shortcuts during live recording: Space = pause/resume, Esc = stop.
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

  // Check GitHub for a newer release on launch; pop the dialog if found.
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

  // Open a recording by id (used by chat source chips, which may reference any topic).
  const openRecordingById = useCallback(async (recordingId: number) => {
    try {
      const rec = await api.getRecording(recordingId);
      setActiveTopic(rec.topic_id);
      setShowHome(false);
      setShowTasks(false);
      setShowJobs(false);
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

  const proceed = useCallback(() => {
    waitForBackend()
      .then(async () => {
        try {
          const s = await api.setupStatus();
          setNeedsSetup(!s.setup_complete);
        } catch {
          /* ignore — proceed without wizard */
        }
        setReady(true);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    (async () => {
      // On a packaged build the Python env may need to be created first.
      if (isTauri()) {
        const backendReady = await invoke<boolean>("is_backend_ready").catch(() => false);
        if (!backendReady) {
          const envReady = await invoke<boolean>("is_env_ready").catch(() => true);
          if (!envReady) {
            setNeedsEnv(true);
            return;
          }
        }
      }
      proceed();
    })();
  }, [proceed]);

  useEffect(() => {
    if (!ready || needsSetup || needsEnv) return;
    api.getSettings()
      .then((settings) => {
        const accelerator = settings.dictation_shortcut || "Alt+Meta+D";
        setDictationShortcutLabel(shortcutLabel(accelerator));
        if (isTauri()) {
          return Promise.all([
            invoke<string>("set_dictation_shortcut", { accelerator }).catch((e) => {
              toast(`Diktat-Hotkey konnte nicht gesetzt werden: ${String(e)}`, "error");
            }),
            invoke<void>("configure_meeting_detection", {
              enabled: settings.meeting_detection_enabled,
              apps: settings.meeting_detection_apps,
            }).catch(() => {}),
          ]);
        }
      })
      .catch(() => {});
  }, [needsEnv, needsSetup, ready, toast]);

  const startDetectedMeeting = useCallback(async () => {
    if (recordingRef.current.state !== "idle") {
      setDetectedMeeting(null);
      return;
    }
    try {
      let topic = topics?.find((t) => t.name.toLowerCase() === "meetings");
      if (!topic) {
        topic = await api.createTopic("Meetings", "#0f766e");
        await queryClient.invalidateQueries({ queryKey: ["topics"] });
      }
      setActiveTopic(topic.id);
      setShowHome(false);
      setShowTasks(false);
      setShowJobs(false);
      setOpenRecording(null);
      await recordingRef.current.start(topic.id, topic.name);
      setDetectedMeeting(null);
    } catch (e) {
      toast(`Meeting-Aufnahme konnte nicht gestartet werden: ${(e as Error).message}`, "error");
    }
  }, [queryClient, toast, topics]);

  // React to native menu items (Tauri only).
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlisteners: (() => void)[] = [];
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<string>("menu", (e) => {
        if (e.payload === "settings") setShowSettings(true);
        if (e.payload === "new-topic") setShowTopicModal(true);
        if (e.payload === "record-start") {
          const topic = currentTopicRef.current;
          const activeRecording = recordingRef.current;
          if (!topic) {
            setShowTopicModal(true);
            toast("Wähle zuerst einen Themenbereich für die Aufnahme.", "info");
            return;
          }
          if (activeRecording.state === "idle") {
            void activeRecording.start(topic.id, topic.name);
          }
        }
        if (e.payload === "record-pause") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state === "recording") activeRecording.pause();
        }
        if (e.payload === "record-resume") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state === "paused") activeRecording.resume();
        }
        if (e.payload === "record-stop") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state === "recording" || activeRecording.state === "paused") {
            void activeRecording.stop();
          }
        }
        if (e.payload === "dictation-toggle") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state !== "idle") {
            toast("Diktat kann während einer laufenden Aufnahme nicht gestartet werden.", "info");
            return;
          }
          void dictationRef.current.toggle();
        }
        if (e.payload === "check-update") {
          checkForUpdate().then((u) => {
            if (u) {
              setUpdate(u);
              setShowUpdate(true);
            } else {
              toast("Tarscribe ist auf dem neuesten Stand.", "success");
            }
          });
        }
      }).then((u) => unlisteners.push(u));
      listen<{ app_name: string }>("meeting-detected", (e) => {
        // Don't offer to record while already recording, or while dictation is
        // using the mic — the live mic would otherwise read as a "meeting".
        if (recordingRef.current.state !== "idle") return;
        if (dictationRef.current.state !== "idle") return;
        setDetectedMeeting({ appName: e.payload.app_name });
      }).then((u) => unlisteners.push(u));
    });
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [toast]);

  // Keep the selection valid when the active topic is deleted.
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
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <LogoIcon className="logo" />
          </div>
          <div>
            <div>Tarscribe</div>
            <span>Lokal & privat</span>
          </div>
        </div>

        <button
          className={`topic-item ${showHome ? "active" : ""}`}
          onClick={() => {
            setShowHome(true);
            setShowTasks(false);
            setShowJobs(false);
            setOpenRecording(null);
          }}
        >
          <HomeIcon width={16} height={16} /> Start
        </button>

        <button
          className={`topic-item ${showTasks ? "active" : ""}`}
          onClick={() => {
            setShowTasks(true);
            setShowHome(false);
            setShowJobs(false);
            setOpenRecording(null);
          }}
        >
          <TasksIcon width={16} height={16} /> Aufgaben
        </button>

        <button
          className={`topic-item debug-jobs-nav ${showJobs ? "active" : ""}`}
          title="Laufende Jobs"
          onClick={() => {
            setShowJobs(true);
            setShowTasks(false);
            setShowHome(false);
            setOpenRecording(null);
          }}
        >
          <ActivityIcon width={16} height={16} /> Jobs
        </button>

        <div className="section-label">
          <span>Bibliothek</span>
          <button
            className="btn ghost"
            style={{ padding: 2 }}
            title="Neuer Themenbereich"
            onClick={() => setShowTopicModal(true)}
          >
            <PlusIcon width={15} height={15} />
          </button>
        </div>

        <div className="topic-list">
          {(topics ?? []).map((t, i) => (
            <TopicRow
              key={t.id}
              topic={t}
              active={t.id === activeTopic && !showHome && !showTasks && !showJobs}
              canMoveUp={i > 0}
              canMoveDown={i < (topics?.length ?? 0) - 1}
              onSelect={() => {
                setActiveTopic(t.id);
                setOpenRecording(null);
                setShowHome(false);
                setShowTasks(false);
                setShowJobs(false);
              }}
              onMoveUp={() => moveTopic(t.id, -1)}
              onMoveDown={() => moveTopic(t.id, 1)}
            />
          ))}
        </div>

        {topics?.length === 0 && (
          <button className="topic-item" onClick={() => setShowTopicModal(true)}>
            <PlusIcon width={15} height={15} /> Ersten Bereich anlegen
          </button>
        )}

        <div style={{ flex: 1 }} />
        <div className="sidebar-status">
          <span className="sidebar-status-dot" />
          <div>
            <strong>Lokaler Arbeitsbereich</strong>
            <span>Audio, Transkripte und Chat bleiben auf diesem Mac.</span>
          </div>
        </div>
        <button className="topic-item" onClick={() => setShowSettings(true)}>
          <SettingsIcon width={16} height={16} /> Einstellungen
        </button>
      </aside>

      <div className="resizer" onMouseDown={handleResizerDown} />

      <main className="main">
        <div className="topbar">
          <div className="topbar-title">
            <span className="topbar-eyebrow">
              {showJobs ? "Debug" : showTasks ? "Aufgaben" : showHome ? "Start" : openRecording ? "Aufnahme" : "Themenbereich"}
            </span>
            <h1>
              {showJobs
                ? "Jobs"
                : showTasks
                ? "Action-Items"
                : showHome
                  ? "Tarscribe"
                  : openRecording
                    ? openRecording.title
                    : current
                      ? current.name
                      : "Tarscribe"}
            </h1>
          </div>
          <div className="spacer" />
          {recording.state === "idle" && <GlobalRecordingIndicator />}
          {current && !showHome && !showTasks && !showJobs && (
            <>
              <button
                className="btn ghost"
                title={current.export_path ? `Export-Ordner: ${current.export_path}` : "Export-Ordner festlegen"}
                onClick={() => setShowTopicExport(true)}
              >
                <FolderIcon width={16} height={16} />
                {current.export_path ? "Export bereit" : "Export-Ordner"}
              </button>
              <TopicCalendarControl topic={current} />
            </>
          )}
          <HardwarePill />
        </div>
        <div className="content">
          {recording.state !== "idle" ? (
            <LiveRecordingDetail
              topicName={recording.topicName ?? "Aufnahme"}
              elapsed={recording.elapsed}
              state={recording.state}
              handle={recording.liveHandle}
              onPause={recording.pause}
              onResume={recording.resume}
              onStop={recording.stop}
            />
          ) : showJobs ? (
            <JobsPage onOpenRecording={openRecordingById} />
          ) : showTasks ? (
            <TasksPage topics={topics ?? []} onOpenRecording={openRecordingById} />
          ) : showHome ? (
            <StartPage
              topics={topics ?? []}
              onOpenSource={openRecordingById}
              dictation={dictation}
              dictationShortcutLabel={dictationShortcutLabel}
            />
          ) : openRecording ? (
            <RecordingDetail
              recording={openRecording}
              topics={topics ?? []}
              onBack={() => setOpenRecording(null)}
              onMoved={(rec) => {
                setActiveTopic(rec.topic_id);
                setOpenRecording(rec);
              }}
              onOpenSettings={() => setShowSettings(true)}
            />
          ) : current ? (
            <RecordingList topic={current} onOpen={setOpenRecording} />
          ) : (
            <StartPage
              topics={topics ?? []}
              onOpenSource={openRecordingById}
              dictation={dictation}
              dictationShortcutLabel={dictationShortcutLabel}
            />
          )}
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
