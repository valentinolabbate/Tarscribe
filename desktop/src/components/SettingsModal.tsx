import { useEffect, useState } from "react";
import { useDeleteKnownSpeaker, useKnownSpeakers } from "../hooks/queries";
import { api } from "../lib/api";
import { listRecordingDevices, type RecordingDevice } from "../lib/recorder";
import { SpeakerIdIcon, TrashIcon } from "./icons";
import { LlmSettings } from "./LlmSettings";
import { TemplatesModal } from "./TemplatesModal";
import type { AppSettings } from "../lib/types";

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

  useEffect(() => {
    api.getSettings().then(setSettings);
    listRecordingDevices().then(setRecordingDevices).catch(() => {});
  }, []);

  async function refreshRecordingDevices() {
    try {
      setRecordingDevices(await listRecordingDevices(true));
    } catch (e) {
      setStatus({ ok: false, msg: `Mikrofone konnten nicht geladen werden: ${(e as Error).message}` });
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2>Einstellungen</h2>

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
                type="text"
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
          {status && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                color: status.ok ? "var(--ok)" : "var(--danger)",
              }}
            >
              {status.msg}
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
            Token erstellen unter huggingface.co/settings/tokens und die Lizenz von
            <br />
            <code>pyannote/speaker-diarization-community-1</code> akzeptieren. Wird sicher in der
            OS-Keychain gespeichert.
          </div>
        </div>

        <LlmSettings />

        <div className="field">
          <label>Zusammenfassungs-Vorlagen</label>
          <button className="btn" onClick={() => setShowTemplates(true)}>
            Vorlagen verwalten
          </button>
        </div>

        <KnownSpeakers />

        {settings && (
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
        )}

        {settings && (
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
        )}

        {settings && (
          <div className="field">
            <label>Diarisierungs-Modell</label>
            <input type="text" value={settings.diarization_model} readOnly />
          </div>
        )}

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
