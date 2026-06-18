import { useEffect, useState } from "react";
import { useDeleteKnownSpeaker, useKnownSpeakers } from "../hooks/queries";
import { api } from "../lib/api";
import { PERFORMANCE_PROFILES } from "../lib/performanceProfiles";
import { errorMessage, listRecordingDevices, type RecordingDevice } from "../lib/recorder";
import { getSystemAudioCapability, invoke, isTauri, pickFolder, type SystemAudioCapability } from "../lib/tauri";
import { CalendarIcon, ChatIcon, SettingsIcon, SpeakerIdIcon, SummaryIcon, TrashIcon } from "./icons";
import { LlmSettings } from "./LlmSettings";
import { McpSettings } from "./McpSettings";
import { RagSettings } from "./RagSettings";
import { TemplatesModal } from "./TemplatesModal";
import type { AppSettings, HardwareInfo, PerformanceProfile } from "../lib/types";

function KnownSpeakers() {
  const { data: speakers } = useKnownSpeakers();
  const del = useDeleteKnownSpeaker();
  return (
    <div className="field">
      <label>Bekannte Sprecher (Stimmproben)</label>
      {speakers && speakers.length > 0 ? (
        <div className="known-list">
          {speakers.map((s) => (
            <div className="known-item" key={s.id}>
              <span className="topic-dot" style={{ background: s.color }} />
              <SpeakerIdIcon width={15} height={15} />
              <span style={{ fontWeight: 550 }}>{s.name}</span>
              <span className="rec-sub">{s.sample_count} Probe(n)</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost danger" style={{ padding: 4 }} onClick={() => del.mutate(s.id)}>
                <TrashIcon width={15} height={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rec-sub" style={{ fontSize: 12 }}>
          Noch keine. In einer Aufnahme bei einem Sprecher auf das Stimmen-Symbol klicken, um eine
          Stimmprobe zu speichern.
        </div>
      )}
    </div>
  );
}

type AsrEngine = "" | "parakeet-mlx" | "faster-whisper";

const ASR_MODEL_SUGGESTIONS: Array<{
  engine: Exclude<AsrEngine, "">;
  label: string;
  model: string;
  note: string;
}> = [
  {
    engine: "parakeet-mlx",
    label: "Parakeet MLX",
    model: "mlx-community/parakeet-tdt-0.6b-v3",
    note: "empfohlen auf Apple Silicon",
  },
  {
    engine: "faster-whisper",
    label: "Whisper Small",
    model: "small",
    note: "schnell und sparsam",
  },
  {
    engine: "faster-whisper",
    label: "Whisper Medium",
    model: "medium",
    note: "ausgewogen",
  },
  {
    engine: "faster-whisper",
    label: "Whisper Large v3",
    model: "large-v3",
    note: "hohe Qualität",
  },
  {
    engine: "faster-whisper",
    label: "Distil Large v3",
    model: "distil-large-v3",
    note: "schneller large-v3-Ableger",
  },
];

const DIARIZATION_MODEL_SUGGESTIONS = [
  {
    label: "Community 1",
    model: "pyannote/speaker-diarization-community-1",
    note: "aktueller Standard",
  },
  {
    label: "Pyannote 3.1",
    model: "pyannote/speaker-diarization-3.1",
    note: "Alternative mit HF-Lizenz",
  },
  {
    label: "Pyannote 3.0",
    model: "pyannote/speaker-diarization-3.0",
    note: "ältere Alternative",
  },
];

type SettingsTab = "general" | "models" | "summaries" | "rag" | "calendar" | "speakers" | "agents";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [token, setToken] = useState("");
  const [caldavPassword, setCaldavPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [recordingDevices, setRecordingDevices] = useState<RecordingDevice[]>([]);
  const [systemAudioCapability, setSystemAudioCapability] = useState<SystemAudioCapability | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [tab, setTab] = useState<SettingsTab>("general");
  const { data: knownSpeakers } = useKnownSpeakers();

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.hardware().then(setHardware).catch(() => {});
    listRecordingDevices().then(setRecordingDevices).catch(() => {});
    getSystemAudioCapability().then(setSystemAudioCapability).catch(() => {});
  }, []);

  async function refreshRecordingDevices() {
    try {
      setRecordingDevices(await listRecordingDevices(true));
    } catch (e) {
      setStatus({ ok: false, msg: `Mikrofone konnten nicht geladen werden: ${errorMessage(e)}` });
    }
  }

  async function chooseDigestFolder() {
    if (!settings) return;
    const dir = await pickFolder();
    if (!dir) return;
    setSettings({ ...settings, digest_export_path: dir });
    api.updateSettings({ digest_export_path: dir });
  }

  async function saveDictationShortcut(value: string) {
    const dictation_shortcut = value.trim() || "Alt+Meta+D";
    setSettings((s) => (s ? { ...s, dictation_shortcut } : s));
    try {
      await api.updateSettings({ dictation_shortcut });
      if (isTauri()) await invoke<string>("set_dictation_shortcut", { accelerator: dictation_shortcut });
      setStatus({ ok: true, msg: "Diktat-Hotkey gespeichert." });
    } catch (e) {
      setStatus({ ok: false, msg: `Diktat-Hotkey ungültig: ${(e as Error).message}` });
    }
  }

  async function saveMeetingDetection(next: Pick<AppSettings, "meeting_detection_enabled" | "meeting_detection_apps">) {
    setSettings((s) => (s ? { ...s, ...next } : s));
    try {
      await api.updateSettings(next);
      if (isTauri()) {
        await invoke<void>("configure_meeting_detection", {
          enabled: next.meeting_detection_enabled,
          apps: next.meeting_detection_apps,
        });
      }
      setStatus({ ok: true, msg: "Meeting-Erkennung gespeichert." });
    } catch (e) {
      setStatus({ ok: false, msg: `Meeting-Erkennung konnte nicht gespeichert werden: ${(e as Error).message}` });
    }
  }

  async function savePerformanceProfile(performance_profile: PerformanceProfile) {
    if (!settings || settings.performance_profile === performance_profile) return;
    const previous = settings;
    setSettings({ ...settings, performance_profile });
    try {
      await api.updateSettings({ performance_profile });
      setStatus({ ok: true, msg: "Leistungsstufe gespeichert." });
    } catch (e) {
      setSettings(previous);
      setStatus({ ok: false, msg: `Leistungsstufe konnte nicht gespeichert werden: ${(e as Error).message}` });
    }
  }

  async function saveAsrEngine(asr_override: AsrEngine) {
    if (!settings) return;
    setSettings({ ...settings, asr_override });
    try {
      await api.updateSettings({ asr_override });
      setStatus({ ok: true, msg: "Transkriptions-Engine gespeichert." });
    } catch (e) {
      setStatus({ ok: false, msg: `Transkriptions-Engine konnte nicht gespeichert werden: ${(e as Error).message}` });
    }
  }

  async function saveAsrModel(value: string) {
    if (!settings) return;
    const asr_model = value.trim();
    setSettings({ ...settings, asr_model });
    try {
      await api.updateSettings({ asr_model });
      setStatus({ ok: true, msg: asr_model ? "Transkriptions-Modell gespeichert." : "Transkriptions-Modell auf Vorschlag zurückgesetzt." });
    } catch (e) {
      setStatus({ ok: false, msg: `Transkriptions-Modell konnte nicht gespeichert werden: ${(e as Error).message}` });
    }
  }

  async function applyAsrSuggestion(suggestion: (typeof ASR_MODEL_SUGGESTIONS)[number]) {
    if (!settings) return;
    setSettings({ ...settings, asr_override: suggestion.engine, asr_model: suggestion.model });
    try {
      await api.updateSettings({ asr_override: suggestion.engine, asr_model: suggestion.model });
      setStatus({ ok: true, msg: "Transkriptions-Modell gespeichert." });
    } catch (e) {
      setStatus({ ok: false, msg: `Transkriptions-Modell konnte nicht gespeichert werden: ${(e as Error).message}` });
    }
  }

  async function saveDiarizationModel(value: string) {
    if (!settings) return;
    const diarization_model = value.trim();
    setSettings({ ...settings, diarization_model });
    try {
      await api.updateSettings({ diarization_model });
      setStatus({ ok: true, msg: "Diarisierungs-Modell gespeichert." });
    } catch (e) {
      setStatus({ ok: false, msg: `Diarisierungs-Modell konnte nicht gespeichert werden: ${(e as Error).message}` });
    }
  }

  async function applyDiarizationSuggestion(suggestion: (typeof DIARIZATION_MODEL_SUGGESTIONS)[number]) {
    if (!settings) return;
    setSettings({ ...settings, diarization_model: suggestion.model });
    try {
      await api.updateSettings({ diarization_model: suggestion.model });
      setStatus({ ok: true, msg: "Diarisierungs-Modell gespeichert." });
    } catch (e) {
      setStatus({ ok: false, msg: `Diarisierungs-Modell konnte nicht gespeichert werden: ${(e as Error).message}` });
    }
  }

  async function saveToken() {
    if (!token.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.setHfToken(token.trim());
      if (res.valid) {
        setStatus({ ok: true, msg: `Token gültig${res.name ? ` (${res.name})` : ""}` });
        setToken("");
        setSettings((s) => (s ? { ...s, hf_token_set: true } : s));
      } else {
        setStatus({ ok: false, msg: `Gespeichert, aber nicht verifiziert: ${res.error ?? ""}` });
        setSettings((s) => (s ? { ...s, hf_token_set: true } : s));
      }
    } catch (e) {
      setStatus({ ok: false, msg: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function saveCaldav() {
    if (!settings) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.updateSettings({ caldav: settings.caldav });
      if (caldavPassword.trim()) {
        const res = await api.setCaldavPassword(caldavPassword.trim());
        setSettings((s) => (s ? { ...s, caldav_password_set: res.caldav_password_set } : s));
        setCaldavPassword("");
      }
      setStatus({ ok: true, msg: "Kalender-Verbindung gespeichert." });
    } catch (e) {
      setStatus({ ok: false, msg: `Kalender-Verbindung konnte nicht gespeichert werden: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function testCaldav() {
    if (!settings) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.testCaldav({
        url: settings.caldav.url,
        username: settings.caldav.username,
        password: caldavPassword.trim() || undefined,
      });
      setStatus({
        ok: res.ok,
        msg: res.ok
          ? `Kalender erreichbar${res.status ? ` (HTTP ${res.status})` : ""}.`
          : `Kalender nicht erreichbar${res.status ? ` (HTTP ${res.status})` : ""}: ${res.error ?? "Unbekannter Fehler"}`,
      });
    } catch (e) {
      setStatus({ ok: false, msg: `Kalender-Test fehlgeschlagen: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function removeCaldavPassword() {
    setBusy(true);
    await api.deleteCaldavPassword();
    setSettings((s) => (s ? { ...s, caldav_password_set: false } : s));
    setStatus({ ok: true, msg: "Kalender-Passwort entfernt." });
    setBusy(false);
  }

  async function removeToken() {
    setBusy(true);
    await api.deleteHfToken();
    setSettings((s) => (s ? { ...s, hf_token_set: false } : s));
    setStatus(null);
    setBusy(false);
  }

  const statusEl = status && (
    <div style={{ marginTop: 8, fontSize: 12, color: status.ok ? "var(--ok)" : "var(--danger)" }}>
      {status.msg}
    </div>
  );

  const TABS = [
    {
      id: "general",
      label: "Allgemein",
      description: "Audio, Sprache, Hotkeys",
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
          <div>
            <h2>Einstellungen</h2>
            <p>Alles, was Tarscribe dauerhaft für Aufnahme, Modelle und Exporte nutzt.</p>
          </div>
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
                  <small>{t.description}</small>
                </span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            <div className="settings-pane-head">
              <span>{activeTab.label}</span>
              <p>{activeTab.description}</p>
            </div>

            {/* ── Allgemein ───────────────────────────────────────────────── */}
            {tab === "general" && settings && (
              <>
                <div className="settings-section-title">
                  <span>Aufnahme</span>
                  <small>Quelle, Mikrofon und Sprache für neue Aufnahmen.</small>
                </div>
                <div className="field">
                  <label>Aufnahmequelle</label>
                  <select
                    value={settings.recording_source}
                    onChange={(e) => {
                      const recording_source = e.target.value as AppSettings["recording_source"];
                      setSettings({ ...settings, recording_source });
                      api.updateSettings({ recording_source });
                    }}
                  >
                    <option value="microphone">Nur Mikrofon</option>
                    <option value="system_audio" disabled={!systemAudioCapability?.supported}>
                      Nur Systemaudio
                    </option>
                    <option value="system_audio_and_microphone" disabled={!systemAudioCapability?.supported}>
                      Systemaudio + Mikrofon
                    </option>
                  </select>
                  <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                    {systemAudioCapability?.supported
                      ? `macOS ${systemAudioCapability.current_macos_version}: Systemaudio kann ohne zusätzlich installierte Programme aufgenommen werden.`
                      : systemAudioCapability?.reason ?? "Prüfe native Systemaudio-Unterstützung…"}
                  </div>
                </div>

                <div className="field">
                  <label>Standard-Mikrofon</label>
                  <select
                    value={settings.recording_device_id}
                    onChange={(e) => {
                      const recording_device_id = e.target.value;
                      setSettings({ ...settings, recording_device_id });
                      api.updateSettings({ recording_device_id });
                    }}
                  >
                    <option value="">Systemstandard</option>
                    {recordingDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                    <button className="btn" onClick={refreshRecordingDevices}>
                      Geräte aktualisieren
                    </button>
                  </div>
                </div>

                <div className="field">
                  <label>Transkriptions-Sprache</label>
                  <select
                    value={settings.language ?? ""}
                    onChange={(e) => {
                      const language = e.target.value || null;
                      setSettings({ ...settings, language });
                      api.updateSettings({ language });
                    }}
                  >
                    <option value="">Automatisch erkennen</option>
                    <option value="de">Deutsch</option>
                    <option value="en">Englisch</option>
                    <option value="fr">Französisch</option>
                    <option value="es">Spanisch</option>
                    <option value="it">Italienisch</option>
                  </select>
                </div>

                <div className="settings-section-title">
                  <span>Automationen</span>
                  <small>Kurze Wege für Diktat und Meeting-Erkennung.</small>
                </div>
                <div className="field">
                  <label>Diktat-Hotkey</label>
                  <input
                    type="text"
                    value={settings.dictation_shortcut ?? "Alt+Meta+D"}
                    placeholder="Alt+Meta+D"
                    onChange={(e) => setSettings({ ...settings, dictation_shortcut: e.target.value })}
                    onBlur={(e) => saveDictationShortcut(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                    Format: <code>Alt+Meta+D</code>, <code>Shift+Meta+N</code> oder <code>Control+Alt+M</code>.
                    Meta entspricht auf dem Mac der Command-Taste.
                  </div>
                </div>

                <div className="field">
                  <label>Meeting-Erkennung</label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={settings.meeting_detection_enabled}
                      onChange={(e) =>
                        saveMeetingDetection({
                          meeting_detection_enabled: e.target.checked,
                          meeting_detection_apps: settings.meeting_detection_apps,
                        })
                      }
                    />
                    <span>Aufnahme anbieten, wenn eine Meeting-App aktiv das Mikrofon nutzt</span>
                  </label>
                  <textarea
                    value={(settings.meeting_detection_apps ?? []).join("\n")}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        meeting_detection_apps: e.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean),
                      })
                    }
                    onBlur={(e) =>
                      saveMeetingDetection({
                        meeting_detection_enabled: settings.meeting_detection_enabled,
                        meeting_detection_apps: e.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean),
                      })
                    }
                    rows={4}
                    spellCheck={false}
                  />
                  <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                    Ein App-Name pro Zeile, z. B. <code>zoom.us</code> oder <code>Microsoft Teams</code>.
                    Die Aufnahme wird nur vorgeschlagen, wenn die App gerade das Mikrofon nutzt – im
                    Hintergrund laufende Apps lösen keinen Hinweis mehr aus. Für Browser-Meetings die
                    Browser-App ergänzen (z. B. <code>Google Chrome</code>).
                  </div>
                </div>

                {statusEl}
              </>
            )}

            {/* ── Modelle ─────────────────────────────────────────────────── */}
            {tab === "models" && settings && (
              <>
                <div className="settings-section-title">
                  <span>Laufzeitprofil</span>
                  <small>Speicherverhalten und Rechenmodus, nicht deine Modellwahl.</small>
                </div>
                <div className="field">
                  <label>Leistungsstufe</label>
                  <div className="settings-info-box">
                    Die Leistungsstufe ist ein Laufzeitprofil. Sie wählt nur dann Standardmodelle,
                    wenn unten kein eigenes Modell eingetragen ist, und regelt sonst vor allem
                    Chunk-Größe, Rechenpräzision und Speaker-Matching auf knappen Geräten.
                  </div>
                  <div className="performance-options">
                    {PERFORMANCE_PROFILES.map((profile) => {
                      const active = settings.performance_profile === profile.id;
                      const recommended = hardware?.recommended_profile === profile.id;
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          className={active ? "performance-option active" : "performance-option"}
                          onClick={() => savePerformanceProfile(profile.id)}
                        >
                          <span className="performance-option-head">
                            <strong>{profile.label}</strong>
                            {recommended && <span className="mini-badge">Empfohlen</span>}
                          </span>
                          <span>{profile.detail}</span>
                          <span className="performance-option-meta">
                            <span>{profile.asr}</span>
                            <span>{profile.diarization}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                    {hardware
                      ? `${hardware.is_apple_silicon ? "Apple Silicon" : `${hardware.os} / ${hardware.arch}`}${hardware.memory_gb ? `, ${hardware.memory_gb} GB RAM` : ""}. Hohe Qualität ist für moderne Laptops realistisch; 24 GB RAM sind komfortabel, 16 GB funktionieren bei vielen Workflows ebenfalls.`
                      : "Prüfe RAM und GPU für die empfohlene Stufe…"}
                  </div>
                </div>

                <div className="settings-section-title">
                  <span>Transkription</span>
                  <small>Engine auswählen, Modell frei eintragen.</small>
                </div>
                <div className="field">
                  <label>Transkriptions-Modell</label>
                  <div className="model-row">
                    <select
                      value={settings.asr_override ?? ""}
                      aria-label="Transkriptions-Engine"
                      onChange={(e) => saveAsrEngine(e.target.value as AsrEngine)}
                    >
                      <option value="">Automatisch nach System</option>
                      <option value="parakeet-mlx">Parakeet MLX</option>
                      <option value="faster-whisper">faster-whisper</option>
                    </select>
                    <input
                      type="text"
                      list="asr-model-suggestions"
                      value={settings.asr_model ?? ""}
                      placeholder={
                        settings.asr_override === "faster-whisper"
                          ? "medium, large-v3 oder eigener Modellname"
                          : "mlx-community/parakeet-tdt-0.6b-v3"
                      }
                      onChange={(e) => setSettings({ ...settings, asr_model: e.target.value })}
                      onBlur={(e) => saveAsrModel(e.target.value)}
                      spellCheck={false}
                    />
                    <datalist id="asr-model-suggestions">
                      {ASR_MODEL_SUGGESTIONS.map((suggestion) => (
                        <option key={`${suggestion.engine}:${suggestion.model}`} value={suggestion.model} />
                      ))}
                    </datalist>
                  </div>
                  <div className="suggestion-chips">
                    {ASR_MODEL_SUGGESTIONS.filter(
                      (suggestion) => !settings.asr_override || suggestion.engine === settings.asr_override,
                    ).map((suggestion) => (
                      <button
                        key={`${suggestion.engine}:${suggestion.model}`}
                        type="button"
                        className="suggestion-chip"
                        onClick={() => applyAsrSuggestion(suggestion)}
                      >
                        <span>{suggestion.label}</span>
                        <code>{suggestion.model}</code>
                        <small>{suggestion.note}</small>
                      </button>
                    ))}
                  </div>
                  <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                    Die Vorschläge füllen das Feld nur aus. Du kannst jeden kompatiblen Modellnamen
                    oder Modellpfad verwenden.
                  </div>
                </div>

                <div className="settings-section-title">
                  <span>Diarisierung</span>
                  <small>Sprechertrennung und pyannote-Modell.</small>
                </div>
                <div className="field">
                  <label>Hugging Face Token</label>
                  {settings.hf_token_set ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        justifyContent: "space-between",
                      }}
                    >
                      <span className="badge ready">✓ Token hinterlegt</span>
                      <button className="btn ghost danger" onClick={removeToken} disabled={busy}>
                        Entfernen
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        type="password"
                        placeholder="hf_xxxxxxxxxxxxxxxxxxxx"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                        <button className="btn primary" onClick={saveToken} disabled={busy || !token.trim()}>
                          {busy ? "Prüfe…" : "Speichern & prüfen"}
                        </button>
                      </div>
                    </>
                  )}
                  <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
                    Für viele pyannote-Modelle ist ein Token nötig. Er wird in der OS-Keychain
                    gespeichert; die Modelllizenz akzeptierst du bei Hugging Face.
                  </div>
                </div>

                <div className="field">
                  <label>Diarisierungs-Modell</label>
                  <input
                    type="text"
                    list="diarization-model-suggestions"
                    value={settings.diarization_model}
                    placeholder="pyannote/speaker-diarization-community-1"
                    onChange={(e) => setSettings({ ...settings, diarization_model: e.target.value })}
                    onBlur={(e) => saveDiarizationModel(e.target.value)}
                    spellCheck={false}
                  />
                  <datalist id="diarization-model-suggestions">
                    {DIARIZATION_MODEL_SUGGESTIONS.map((suggestion) => (
                      <option key={suggestion.model} value={suggestion.model} />
                    ))}
                  </datalist>
                  <div className="suggestion-chips">
                    {DIARIZATION_MODEL_SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion.model}
                        type="button"
                        className="suggestion-chip"
                        onClick={() => applyDiarizationSuggestion(suggestion)}
                      >
                        <span>{suggestion.label}</span>
                        <code>{suggestion.model}</code>
                        <small>{suggestion.note}</small>
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 4, lineHeight: 1.5 }}>
                    Vorschläge sind nur Startpunkte. Du kannst jedes kompatible pyannote-Modell oder
                    einen eigenen Modellpfad eintragen.
                  </div>
                </div>

                {statusEl}
              </>
            )}

            {/* ── Zusammenfassung (LLM) ───────────────────────────────────── */}
            {tab === "summaries" && (
              <>
                <LlmSettings />

                {settings && (
                  <div className="field">
                    <label>Themenbereich-Wissen</label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.summary_use_topic_knowledge ?? true}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setSettings({ ...settings, summary_use_topic_knowledge: next });
                          api.updateSettings({ summary_use_topic_knowledge: next });
                        }}
                      />
                      <span>Relevantes Wissen aus dem Themenbereich in Zusammenfassungen einbeziehen</span>
                    </label>
                    <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                      Zieht passende Passagen aus anderen Transkripten, Zusammenfassungen und
                      hochgeladenen Dateien desselben Themenbereichs hinzu. Benötigt aktiven
                      Wissens-Chat (RAG).
                    </div>
                  </div>
                )}

                {settings && (
                  <div className="field">
                    <label>Wochen-Digest Export-Ordner</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        type="text"
                        placeholder="/Users/du/Obsidian/Wochen"
                        value={settings.digest_export_path ?? ""}
                        onChange={(e) => setSettings({ ...settings, digest_export_path: e.target.value })}
                        onBlur={(e) => api.updateSettings({ digest_export_path: e.target.value.trim() })}
                        style={{ flex: 1 }}
                        spellCheck={false}
                      />
                      {isTauri() && (
                        <button className="btn" onClick={chooseDigestFolder}>
                          Durchsuchen…
                        </button>
                      )}
                    </div>
                    <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                      Dorthin schreibt Tarscribe den Wochen-Digest als Markdown, getrennt von den
                      Themenbereich-Exporten.
                    </div>
                  </div>
                )}

                <div className="field">
                  <label>Zusammenfassungs-Vorlagen</label>
                  <button className="btn" onClick={() => setShowTemplates(true)}>
                    Vorlagen verwalten
                  </button>
                </div>
              </>
            )}

            {/* ── Wissens-Chat (RAG) ──────────────────────────────────────── */}
            {tab === "rag" && <RagSettings />}

            {/* ── Kalender (CalDAV) ────────────────────────────────────────── */}
            {tab === "calendar" && settings && (
              <>
                <div className="field">
                  <label>CalDAV-Kalender</label>
                  <input
                    type="url"
                    placeholder="https://cloud.example.com/remote.php/dav/calendars/name/tasks/"
                    value={settings.caldav.url}
                    onChange={(e) =>
                      setSettings({ ...settings, caldav: { ...settings.caldav, url: e.target.value } })
                    }
                    spellCheck={false}
                  />
                  <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
                    Kalender-Collection-URL, nicht nur die Web-Oberfläche. Nextcloud zeigt sie in den
                    Kalender-Einstellungen an.
                  </div>
                </div>

                <div className="field">
                  <label>Benutzername</label>
                  <input
                    type="text"
                    value={settings.caldav.username}
                    onChange={(e) =>
                      setSettings({ ...settings, caldav: { ...settings.caldav, username: e.target.value } })
                    }
                    spellCheck={false}
                    autoComplete="username"
                  />
                </div>

                <div className="field">
                  <label>App-Passwort</label>
                  {settings.caldav_password_set && !caldavPassword ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                      <span className="badge ready">✓ Passwort hinterlegt</span>
                      <button className="btn ghost danger" onClick={removeCaldavPassword} disabled={busy}>
                        Entfernen
                      </button>
                    </div>
                  ) : (
                    <input
                      type="password"
                      value={caldavPassword}
                      onChange={(e) => setCaldavPassword(e.target.value)}
                      spellCheck={false}
                      autoComplete="current-password"
                      placeholder={settings.caldav_password_set ? "Neues Passwort setzen" : "App-Passwort"}
                    />
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button className="btn" onClick={testCaldav} disabled={busy || !settings.caldav.url.trim()}>
                    Verbindung testen
                  </button>
                  <button className="btn primary" onClick={saveCaldav} disabled={busy || !settings.caldav.url.trim()}>
                    Speichern
                  </button>
                </div>
                {statusEl}
              </>
            )}

            {/* ── Agenten (MCP) ───────────────────────────────────────────── */}
            {tab === "agents" && <McpSettings />}

            {/* ── Sprecher ────────────────────────────────────────────────── */}
            {tab === "speakers" && (
              <>
                <div className="settings-section-title">
                  <span>Stimmen</span>
                  <small>Gespeicherte Stimmen und Aufgaben-Zuordnung.</small>
                </div>
                <KnownSpeakers />

                {settings && (
                  <div className="field">
                    <label>Das bin ich</label>
                    <select
                      value={settings.my_speaker_id ?? 0}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setSettings({ ...settings, my_speaker_id: v || null });
                        api.updateSettings({ my_speaker_id: v });
                      }}
                    >
                      <option value={0}>— Nicht festgelegt —</option>
                      {(knownSpeakers ?? []).map((sp) => (
                        <option key={sp.id} value={sp.id}>
                          {sp.name}
                        </option>
                      ))}
                    </select>
                    <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 7, lineHeight: 1.5 }}>
                      Der Aufgaben-Bereich zeigt standardmäßig nur Aufgaben und Entscheidungen, die
                      diesem Sprecher zugeordnet sind. In jeder Aufnahme werden weiterhin alle
                      Aufgaben extrahiert; andere lassen sich gezielt zu „Meine Aufgaben“ hinzufügen.
                      {(knownSpeakers ?? []).length === 0 &&
                        " Lege zuerst über „Bekannte Sprecher“ eine Stimme an."}
                    </div>
                  </div>
                )}

                {settings && (
                  <div className="field">
                    <label>Speaker-Match-Schwellenwert</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <input
                        type="range"
                        min={0.1}
                        max={0.95}
                        step={0.05}
                        value={settings.speaker_match_threshold ?? 0.5}
                        style={{ flex: 1 }}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setSettings({ ...settings, speaker_match_threshold: v });
                        }}
                        onMouseUp={(e) => {
                          api.updateSettings({ speaker_match_threshold: Number((e.target as HTMLInputElement).value) });
                        }}
                      />
                      <span className="mono" style={{ width: 34 }}>
                        {(settings.speaker_match_threshold ?? 0.5).toFixed(2)}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 4, lineHeight: 1.5 }}>
                      Wie ähnlich eine Stimme einem bekannten Sprecher sein muss, um als Match zu gelten (0 = immer, 1 = nur exakt).
                    </div>
                  </div>
                )}

              </>
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
