import { useState } from "react";
import { CalendarIcon, ChatIcon, SettingsIcon, SpeakerIdIcon, SummaryIcon } from "./icons";
import { McpSettings } from "./McpSettings";
import { RagSettings } from "./RagSettings";
import { TemplatesModal } from "./TemplatesModal";
import { CalendarSettingsTab } from "./settings/CalendarSettingsTab";
import { GeneralSettingsTab } from "./settings/GeneralSettingsTab";
import { ModelsSettingsTab } from "./settings/ModelsSettingsTab";
import { SpeakersSettingsTab } from "./settings/SpeakersSettingsTab";
import { SummarySettingsTab } from "./settings/SummarySettingsTab";
import { useSettingsModalState } from "./settings/useSettingsModalState";

type SettingsTab = "general" | "models" | "summaries" | "rag" | "calendar" | "speakers" | "agents";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const state = useSettingsModalState();
  const {
    settings,
    setSettings,
    token,
    setToken,
    caldavPassword,
    setCaldavPassword,
    busy,
    status,
    setStatus,
    showTemplates,
    setShowTemplates,
    recordingDevices,
    systemAudioCapability,
    autostartStatus,
    autostartBusy,
    hardware,
    modelStatus,
    modelStatusLoading,
    selectedAsrEngine,
    refreshModelStatus,
    refreshRecordingDevices,
    chooseDigestFolder,
    saveDictationShortcut,
    saveMeetingDetection,
    saveAutostartEnabled,
    savePerformanceProfile,
    saveAsrEngine,
    saveAsrModel,
    applyAsrSuggestion,
    saveDiarizationModel,
    applyDiarizationSuggestion,
    saveToken,
    removeToken,
    saveCaldav,
    testCaldav,
    removeCaldavPassword,
  } = state;

  const statusEl = status && (
    <div style={{ marginTop: 8, fontSize: 12, color: status.ok ? "var(--ok)" : "var(--danger)" }}>
      {status.msg}
    </div>
  );
  const secretStorageWarning = settings && !settings.secret_storage.secure && (
    <div style={{ color: "var(--danger)", fontSize: 11.5, lineHeight: 1.5, marginBottom: 10 }}>
      Die macOS-Keychain ist nicht verfügbar. Tarscribe speichert neue Tokens und Passwörter
      erst, wenn ein sicherer Secret-Speicher erreichbar ist.
    </div>
  );

  const TABS = [
    {
      id: "general",
      label: "Allgemein",
      description: "Start, Audio, Sprache",
      icon: <SettingsIcon width={16} height={16} />,
    },
    {
      id: "models",
      label: "Modelle",
      description: "Transkription & Diarisierung",
      icon: <SpeakerIdIcon width={16} height={16} />,
    },
    {
      id: "summaries",
      label: "Zusammenfassung",
      description: "Chat-Modell & Vorlagen",
      icon: <SummaryIcon width={16} height={16} />,
    },
    {
      id: "rag",
      label: "Wissens-Chat",
      description: "Suche & Embeddings",
      icon: <ChatIcon width={16} height={16} />,
    },
    {
      id: "calendar",
      label: "Kalender",
      description: "CalDAV-Verbindung",
      icon: <CalendarIcon width={16} height={16} />,
    },
    {
      id: "speakers",
      label: "Sprecher",
      description: "Stimmen & Zuordnung",
      icon: <SpeakerIdIcon width={16} height={16} />,
    },
    {
      id: "agents",
      label: "Agenten",
      description: "MCP-Anbindung",
      icon: <ChatIcon width={16} height={16} />,
    },
  ] as const;
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-titlebar">
          <h2>Einstellungen</h2>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "settings-nav-btn active" : "settings-nav-btn"}
                onClick={() => {
                  setTab(t.id);
                  setStatus(null);
                }}
              >
                <span className="settings-nav-icon">{t.icon}</span>
                <span className="settings-nav-copy">
                  <strong>{t.label}</strong>
                </span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            <div className="settings-pane-head">
              <span>{activeTab.label}</span>
              <p>{activeTab.description}</p>
            </div>

            {tab === "general" && settings && (
              <GeneralSettingsTab
                settings={settings}
                setSettings={(next) => setSettings(next)}
                recordingDevices={recordingDevices}
                systemAudioCapability={systemAudioCapability}
                autostartStatus={autostartStatus}
                autostartBusy={autostartBusy}
                statusEl={statusEl}
                refreshRecordingDevices={refreshRecordingDevices}
                saveDictationShortcut={saveDictationShortcut}
                saveMeetingDetection={saveMeetingDetection}
                saveAutostartEnabled={saveAutostartEnabled}
              />
            )}

            {tab === "models" && settings && (
              <ModelsSettingsTab
                settings={settings}
                setSettings={(next) => setSettings(next)}
                hardware={hardware}
                modelStatus={modelStatus}
                modelStatusLoading={modelStatusLoading}
                token={token}
                setToken={setToken}
                busy={busy}
                secretStorageWarning={secretStorageWarning}
                selectedAsrEngine={selectedAsrEngine}
                refreshModelStatus={refreshModelStatus}
                savePerformanceProfile={savePerformanceProfile}
                saveAsrEngine={saveAsrEngine}
                saveAsrModel={saveAsrModel}
                applyAsrSuggestion={applyAsrSuggestion}
                saveDiarizationModel={saveDiarizationModel}
                applyDiarizationSuggestion={applyDiarizationSuggestion}
                saveToken={saveToken}
                removeToken={removeToken}
              />
            )}

            {tab === "summaries" && settings && (
              <SummarySettingsTab
                settings={settings}
                setSettings={(next) => setSettings(next)}
                chooseDigestFolder={chooseDigestFolder}
                onShowTemplates={() => setShowTemplates(true)}
              />
            )}

            {tab === "rag" && <RagSettings />}

            {tab === "calendar" && settings && (
              <CalendarSettingsTab
                settings={settings}
                setSettings={(next) => setSettings(next)}
                caldavPassword={caldavPassword}
                setCaldavPassword={setCaldavPassword}
                busy={busy}
                secretStorageWarning={secretStorageWarning}
                statusEl={statusEl}
                saveCaldav={saveCaldav}
                testCaldav={testCaldav}
                removeCaldavPassword={removeCaldavPassword}
              />
            )}

            {tab === "agents" && <McpSettings />}

            {tab === "speakers" && settings && (
              <SpeakersSettingsTab settings={settings} setSettings={(next) => setSettings(next)} />
            )}
          </div>
        </div>

        {showTemplates && <TemplatesModal onClose={() => setShowTemplates(false)} />}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
