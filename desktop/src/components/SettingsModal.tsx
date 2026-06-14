import { useEffect, useState } from "react";
import { useDeleteKnownSpeaker, useKnownSpeakers } from "../hooks/queries";
import { api } from "../lib/api";
import { PERFORMANCE_PROFILES } from "../lib/performanceProfiles";
import { listRecordingDevices, type RecordingDevice } from "../lib/recorder";
import { getSystemAudioCapability, invoke, isTauri, pickFolder, type SystemAudioCapability } from "../lib/tauri";
import { ChatIcon, SettingsIcon, SpeakerIdIcon, SummaryIcon, TrashIcon } from "./icons";
import { LlmSettings } from "./LlmSettings";
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

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [recordingDevices, setRecordingDevices] = useState<RecordingDevice[]>([]);
  const [systemAudioCapability, setSystemAudioCapability] = useState<SystemAudioCapability | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [tab, setTab] = useState<"general" | "summaries" | "rag" | "speakers">("general");

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
      setStatus({ ok: false, msg: `Mikrofone konnten nicht geladen werden: ${(e as Error).message}` });
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
    { id: "general", label: "Allgemein", icon: <SettingsIcon width={16} height={16} /> },
    { id: "summaries", label: "Zusammenfassung", icon: <SummaryIcon width={16} height={16} /> },
    { id: "rag", label: "Wissens-Chat", icon: <ChatIcon width={16} height={16} /> },
    { id: "speakers", label: "Sprecher", icon: <SpeakerIdIcon width={16} height={16} /> },
  ] as const;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Einstellungen</h2>

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
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {/* ── Allgemein ───────────────────────────────────────────────── */}
            {tab === "general" && settings && (
              <>
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

                <div className="field">
                  <label>Leistungsstufe</label>
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
                      ? `${hardware.is_apple_silicon ? "Apple Silicon" : `${hardware.os} / ${hardware.arch}`}${hardware.memory_gb ? `, ${hardware.memory_gb} GB RAM` : ""}. Niedrigste Stufe nutzt auf M-Macs weiterhin die GPU.`
                      : "Prüfe RAM und GPU für die empfohlene Stufe…"}
                  </div>
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
                    <span>Nach laufenden Meeting-Apps suchen und Aufnahme anbieten</span>
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
                    Browser-Meetings lassen sich erst zuverlässig erkennen, wenn die Browser-App hier ergänzt wird.
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

            {/* ── Sprecher & Diarisierung ─────────────────────────────────── */}
            {tab === "speakers" && (
              <>
                <div className="field">
                  <label>HuggingFace-Token (für Speaker-Diarisierung)</label>
                  {settings?.hf_token_set ? (
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
                  {statusEl}
                  <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
                    Token erstellen unter huggingface.co/settings/tokens und die Lizenz von
                    <br />
                    <code>pyannote/speaker-diarization-community-1</code> akzeptieren. Wird sicher in der
                    OS-Keychain gespeichert.
                  </div>
                </div>

                <KnownSpeakers />

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

                {settings && (
                  <div className="field">
                    <label>Diarisierungs-Modell</label>
                    <input type="text" value={settings.diarization_model} readOnly />
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
