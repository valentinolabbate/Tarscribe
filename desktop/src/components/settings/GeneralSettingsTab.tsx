import type { ReactNode } from "react";
import { api } from "../../lib/api";
import type { AppSettings } from "../../lib/types";
import type { RecordingDevice } from "../../lib/recorder";
import type { AutostartStatus, SystemAudioCapability } from "../../lib/tauri";

export function GeneralSettingsTab({
  settings,
  setSettings,
  recordingDevices,
  systemAudioCapability,
  autostartStatus,
  autostartBusy,
  statusEl,
  refreshRecordingDevices,
  saveDictationShortcut,
  saveMeetingDetection,
  saveAutostartEnabled,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  recordingDevices: RecordingDevice[];
  systemAudioCapability: SystemAudioCapability | null;
  autostartStatus: AutostartStatus;
  autostartBusy: boolean;
  statusEl: ReactNode;
  refreshRecordingDevices: () => void;
  saveDictationShortcut: (value: string) => void;
  saveMeetingDetection: (next: Pick<AppSettings, "meeting_detection_enabled" | "meeting_detection_apps">) => void;
  saveAutostartEnabled: (enabled: boolean) => void;
}) {
  return (
    <>
      <div className="settings-section-title">
        <span>App</span>
      </div>
      <div className="field">
        <label className="check-row">
          <input
            type="checkbox"
            checked={autostartStatus.enabled}
            disabled={!autostartStatus.supported || autostartBusy}
            onChange={(event) => saveAutostartEnabled(event.target.checked)}
          />
          <span>Bei der Anmeldung starten</span>
        </label>
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          {autostartStatus.supported
            ? "Tarscribe startet ohne Fenster und bleibt über die Menüleiste erreichbar."
            : "Autostart kann nur in der installierten Tarscribe-App geändert werden."}
        </div>
      </div>

      <div className="settings-section-title">
        <span>Aufnahme</span>
      </div>
      <div className="field">
        <label>Aufnahmequelle</label>
        <select
          value={settings.recording_source}
          onChange={(event) => {
            const recording_source = event.target.value as AppSettings["recording_source"];
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
            ? "Systemaudio ist verfügbar."
            : systemAudioCapability?.reason ?? "Prüfe native Systemaudio-Unterstützung…"}
        </div>
      </div>

      <div className="field">
        <label>Standard-Mikrofon</label>
        <select
          value={settings.recording_device_id}
          onChange={(event) => {
            const recording_device_id = event.target.value;
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
            Aktualisieren
          </button>
        </div>
      </div>

      <div className="field">
        <label>Transkriptions-Sprache</label>
        <select
          value={settings.language ?? ""}
          onChange={(event) => {
            const language = event.target.value || null;
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
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.live_speaker_detection_enabled}
            onChange={(event) => {
              const live_speaker_detection_enabled = event.target.checked;
              setSettings({ ...settings, live_speaker_detection_enabled });
              api.updateSettings({ live_speaker_detection_enabled });
            }}
          />
          <span>Live-Diarisierung</span>
        </label>
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Trennt Sprecher schon während der Aufnahme. Ausgeschaltet zeigt die Live-Ansicht
          nur Zeitmarken und Transkripttext; die Verarbeitung nach der Aufnahme bleibt unverändert.
        </div>
      </div>

      <div className="field">
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.live_speaker_matching_enabled}
            disabled={!settings.live_speaker_detection_enabled}
            onChange={(event) => {
              const live_speaker_matching_enabled = event.target.checked;
              setSettings({ ...settings, live_speaker_matching_enabled });
              api.updateSettings({ live_speaker_matching_enabled });
            }}
          />
          <span>Live-Speaker-Matching</span>
        </label>
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Ordnet live getrennte Stimmen bekannten Personen zu. Benötigt Live-Diarisierung;
          deine Auswahl bleibt gespeichert, wenn diese vorübergehend ausgeschaltet ist.
        </div>
      </div>

      <div className="settings-section-title">
        <span>Kurzbefehle</span>
      </div>
      <div className="field">
        <label>Diktat-Hotkey</label>
        <input
          type="text"
          value={settings.dictation_shortcut ?? "Alt+Meta+D"}
          placeholder="Alt+Meta+D"
          onChange={(event) => setSettings({ ...settings, dictation_shortcut: event.target.value })}
          onBlur={(event) => saveDictationShortcut(event.target.value)}
          spellCheck={false}
        />
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Beispiel: <code>Alt+Meta+D</code>. Meta entspricht der Command-Taste.
        </div>
      </div>

      <details className="settings-advanced">
        <summary>
          <span>Meeting-Erkennung</span>
          <small>Optional</small>
        </summary>
        <div className="settings-advanced-body">
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.meeting_detection_enabled}
              onChange={(event) =>
                saveMeetingDetection({
                  meeting_detection_enabled: event.target.checked,
                  meeting_detection_apps: settings.meeting_detection_apps,
                })
              }
            />
            <span>Bei aktiven Meeting-Apps eine Aufnahme anbieten</span>
          </label>
          <label className="settings-inline-label">Erkannte Apps</label>
          <textarea
            value={(settings.meeting_detection_apps ?? []).join("\n")}
            onChange={(event) =>
              setSettings({
                ...settings,
                meeting_detection_apps: event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
            onBlur={(event) =>
              saveMeetingDetection({
                meeting_detection_enabled: settings.meeting_detection_enabled,
                meeting_detection_apps: event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
            rows={4}
            spellCheck={false}
          />
          <div className="rec-sub">
            Ein App-Name pro Zeile. Für Browser-Meetings zusätzlich den Browser eintragen.
          </div>
        </div>
      </details>

      {statusEl}
    </>
  );
}
