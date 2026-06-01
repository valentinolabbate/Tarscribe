import { useCallback, useEffect, useState } from "react";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { GlobalRecordingIndicator } from "./components/GlobalRecordingIndicator";
import { LiveRecordingDetail } from "./components/LiveRecordingDetail";
import { SetupScreen } from "./components/SetupScreen";
import { RecordingDetail } from "./components/RecordingDetail";
import { RecordingList } from "./components/RecordingList";
import { SettingsModal } from "./components/SettingsModal";
import { TopicModal } from "./components/TopicModal";
import { UpdateModal } from "./components/UpdateModal";
import { useToast } from "./components/Toast";
import { checkForUpdate, type PendingUpdate } from "./lib/updater";
import { FolderIcon, LogoIcon, PlusIcon, SettingsIcon, TrashIcon } from "./components/icons";
import { TopicExportModal } from "./components/TopicExportModal";
import {
  useDeleteTopic,
  useHardware,
  useRecordings,
  useTopics,
  useUpdateTopic,
} from "./hooks/queries";
import { useJobSocket } from "./hooks/useJobs";
import { useRecording } from "./hooks/useRecording";
import { api, waitForBackend } from "./lib/api";
import { invoke, isTauri } from "./lib/tauri";
import type { Recording, Topic } from "./lib/types";

const clampSidebarWidth = (width: number) =>
  Math.max(160, Math.min(500, window.innerWidth - 640, Number.isFinite(width) ? width : 248));

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
  onSelect,
}: {
  topic: Topic;
  active: boolean;
  onSelect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateTopic();
  const del = useDeleteTopic();
  const recording = useRecording();

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
      className={`topic-item ${active ? "active" : ""}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      title="Doppelklick zum Umbenennen"
    >
      <span className="topic-dot" style={{ background: topic.color }} />
      <span className="topic-name">{topic.name}</span>
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
    </div>
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
    <span className="hw-pill">
      {dev} · ASR: {hw.recommended_asr}
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
  const [showSettings, setShowSettings] = useState(false);
  const [showTopicExport, setShowTopicExport] = useState(false);
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const v = localStorage.getItem("ts-sidebar-w");
      return clampSidebarWidth(v ? Number(v) : 248);
    } catch { return 248; }
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
  const { data: liveRecordings } = useRecordings(activeTopic ?? undefined);
  const toast = useToast();
  const recording = useRecording();
  useJobSocket(recording.dispatchLiveEvent);

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

  // React to native menu items (Tauri only).
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<string>("menu", (e) => {
        if (e.payload === "settings") setShowSettings(true);
        if (e.payload === "new-topic") setShowTopicModal(true);
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
      }).then((u) => (unlisten = u));
    });
    return () => unlisten?.();
  }, []);

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

  const current = topics?.find((t) => t.id === activeTopic);

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <aside className="sidebar">
        <div className="brand">
          <LogoIcon className="logo" />
          Tarscribe
        </div>

        <div className="section-label">
          Themenbereiche
          <button
            className="btn ghost"
            style={{ padding: 2 }}
            title="Neuer Themenbereich"
            onClick={() => setShowTopicModal(true)}
          >
            <PlusIcon width={15} height={15} />
          </button>
        </div>

        {topics?.map((t) => (
          <TopicRow
            key={t.id}
            topic={t}
            active={t.id === activeTopic}
            onSelect={() => {
              setActiveTopic(t.id);
              setOpenRecording(null);
            }}
          />
        ))}

        {topics?.length === 0 && (
          <button className="topic-item" onClick={() => setShowTopicModal(true)}>
            <PlusIcon width={15} height={15} /> Ersten Bereich anlegen
          </button>
        )}

        <div style={{ flex: 1 }} />
        <button className="topic-item" onClick={() => setShowSettings(true)}>
          <SettingsIcon width={16} height={16} /> Einstellungen
        </button>
      </aside>

      <div className="resizer" onMouseDown={handleResizerDown} />

      <main className="main">
        <div className="topbar">
          <h1>{current ? current.name : "Tarscribe"}</h1>
          <div className="spacer" />
          {recording.state === "idle" && <GlobalRecordingIndicator />}
          {current && (
            <button
              className="btn ghost"
              title={current.export_path ? `Export-Ordner: ${current.export_path}` : "Export-Ordner festlegen"}
              onClick={() => setShowTopicExport(true)}
            >
              <FolderIcon width={16} height={16} />
              {current.export_path ? "Ordner ✓" : "Export-Ordner"}
            </button>
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
          ) : openRecording ? (
            <RecordingDetail
              recording={openRecording}
              onBack={() => setOpenRecording(null)}
            />
          ) : current ? (
            <RecordingList topic={current} onOpen={setOpenRecording} />
          ) : (
            <div className="empty">
              <div className="big">Willkommen bei Tarscribe</div>
              <div>Lege links einen Themenbereich an, um loszulegen.</div>
            </div>
          )}
        </div>
      </main>

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
