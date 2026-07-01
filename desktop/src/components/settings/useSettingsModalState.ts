import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { validateHttpUrl } from "../../lib/formValidation";
import { errorMessage, listRecordingDevices, type RecordingDevice } from "../../lib/recorder";
import { getSystemAudioCapability, invoke, isTauri, pickFolder, type SystemAudioCapability } from "../../lib/tauri";
import type { AppSettings, HardwareInfo, ModelStatusPayload, PerformanceProfile } from "../../lib/types";
import {
  ASR_MODEL_SUGGESTIONS,
  DIARIZATION_MODEL_SUGGESTIONS,
  asrEngineValue,
  normalizeAsrModelForEngine,
  type AsrEngine,
} from "./settingsModel";

type SettingsStatus = { ok: boolean; msg: string };

export function useSettingsModalState() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [token, setToken] = useState("");
  const [caldavPassword, setCaldavPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [recordingDevices, setRecordingDevices] = useState<RecordingDevice[]>([]);
  const [systemAudioCapability, setSystemAudioCapability] = useState<SystemAudioCapability | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatusPayload | null>(null);
  const [modelStatusLoading, setModelStatusLoading] = useState(false);
  async function refreshModelStatus() {
    setModelStatusLoading(true);
    try {
      setModelStatus(await api.modelStatus());
    } catch {
      setModelStatus(null);
    } finally {
      setModelStatusLoading(false);
    }
  }

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.hardware().then(setHardware).catch(() => {});
    refreshModelStatus();
    listRecordingDevices().then(setRecordingDevices).catch(() => {});
    getSystemAudioCapability().then(setSystemAudioCapability).catch(() => {});
  }, []);
  async function refreshRecordingDevices() {
    try {
      setRecordingDevices(await listRecordingDevices(true));
    } catch (error) {
      setStatus({ ok: false, msg: `Mikrofone konnten nicht geladen werden: ${errorMessage(error)}` });
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
    setSettings((current) => (current ? { ...current, dictation_shortcut } : current));
    try {
      await api.updateSettings({ dictation_shortcut });
      if (isTauri()) await invoke<string>("set_dictation_shortcut", { accelerator: dictation_shortcut });
      setStatus({ ok: true, msg: "Diktat-Hotkey gespeichert." });
    } catch (error) {
      setStatus({ ok: false, msg: `Diktat-Hotkey ungültig: ${(error as Error).message}` });
    }
  }
  async function saveMeetingDetection(next: Pick<AppSettings, "meeting_detection_enabled" | "meeting_detection_apps">) {
    setSettings((current) => (current ? { ...current, ...next } : current));
    try {
      await api.updateSettings(next);
      if (isTauri()) {
        await invoke<void>("configure_meeting_detection", {
          enabled: next.meeting_detection_enabled,
          apps: next.meeting_detection_apps,
        });
      }
      setStatus({ ok: true, msg: "Meeting-Erkennung gespeichert." });
    } catch (error) {
      setStatus({
        ok: false,
        msg: `Meeting-Erkennung konnte nicht gespeichert werden: ${(error as Error).message}`,
      });
    }
  }
  async function savePerformanceProfile(performance_profile: PerformanceProfile) {
    if (!settings || settings.performance_profile === performance_profile) return;
    const previous = settings;
    setSettings({ ...settings, performance_profile });
    try {
      await api.updateSettings({ performance_profile });
      void refreshModelStatus();
      setStatus({ ok: true, msg: "Leistungsstufe gespeichert." });
    } catch (error) {
      setSettings(previous);
      setStatus({ ok: false, msg: `Leistungsstufe konnte nicht gespeichert werden: ${(error as Error).message}` });
    }
  }
  async function saveAsrEngine(asr_override: AsrEngine) {
    if (!settings) return;
    const asr_model = normalizeAsrModelForEngine(asr_override, settings.asr_model);
    setSettings({ ...settings, asr_override, asr_model });
    try {
      await api.updateSettings({ asr_override, asr_model });
      void refreshModelStatus();
      setStatus({ ok: true, msg: "Transkriptions-Engine gespeichert." });
    } catch (error) {
      setStatus({
        ok: false,
        msg: `Transkriptions-Engine konnte nicht gespeichert werden: ${(error as Error).message}`,
      });
    }
  }

  async function saveAsrModel(value: string) {
    if (!settings) return;
    const asr_model = value.trim();
    setSettings({ ...settings, asr_model });
    try {
      await api.updateSettings({ asr_model });
      void refreshModelStatus();
      setStatus({
        ok: true,
        msg: asr_model ? "Transkriptions-Modell gespeichert." : "Transkriptions-Modell auf Vorschlag zurückgesetzt.",
      });
    } catch (error) {
      setStatus({
        ok: false,
        msg: `Transkriptions-Modell konnte nicht gespeichert werden: ${(error as Error).message}`,
      });
    }
  }

  async function applyAsrSuggestion(suggestion: (typeof ASR_MODEL_SUGGESTIONS)[number]) {
    if (!settings) return;
    setSettings({ ...settings, asr_override: suggestion.engine, asr_model: suggestion.model });
    try {
      await api.updateSettings({ asr_override: suggestion.engine, asr_model: suggestion.model });
      void refreshModelStatus();
      setStatus({ ok: true, msg: "Transkriptions-Modell gespeichert." });
    } catch (error) {
      setStatus({
        ok: false,
        msg: `Transkriptions-Modell konnte nicht gespeichert werden: ${(error as Error).message}`,
      });
    }
  }

  async function saveDiarizationModel(value: string) {
    if (!settings) return;
    const diarization_model = value.trim();
    setSettings({ ...settings, diarization_model });
    try {
      await api.updateSettings({ diarization_model });
      void refreshModelStatus();
      setStatus({ ok: true, msg: "Diarisierungs-Modell gespeichert." });
    } catch (error) {
      setStatus({
        ok: false,
        msg: `Diarisierungs-Modell konnte nicht gespeichert werden: ${(error as Error).message}`,
      });
    }
  }

  async function applyDiarizationSuggestion(suggestion: (typeof DIARIZATION_MODEL_SUGGESTIONS)[number]) {
    if (!settings) return;
    setSettings({ ...settings, diarization_model: suggestion.model });
    try {
      await api.updateSettings({ diarization_model: suggestion.model });
      void refreshModelStatus();
      setStatus({ ok: true, msg: "Diarisierungs-Modell gespeichert." });
    } catch (error) {
      setStatus({
        ok: false,
        msg: `Diarisierungs-Modell konnte nicht gespeichert werden: ${(error as Error).message}`,
      });
    }
  }

  async function saveToken() {
    if (!token.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await api.setHfToken(token.trim());
      if (response.valid) {
        setStatus({ ok: true, msg: `Token gültig${response.name ? ` (${response.name})` : ""}` });
        setToken("");
        setSettings((current) => (current ? { ...current, hf_token_set: true } : current));
      }
    } catch (error) {
      setStatus({ ok: false, msg: `Nicht gespeichert: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function saveCaldav() {
    if (!settings) return;
    const urlError = validateHttpUrl(settings.caldav.url, "CalDAV-URL");
    if (urlError) {
      setStatus({ ok: false, msg: urlError });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.updateSettings({ caldav: settings.caldav });
      if (caldavPassword.trim()) {
        const response = await api.setCaldavPassword(caldavPassword.trim());
        setSettings((current) => (current ? { ...current, caldav_password_set: response.caldav_password_set } : current));
        setCaldavPassword("");
      }
      setStatus({ ok: true, msg: "Kalender-Verbindung gespeichert." });
    } catch (error) {
      setStatus({
        ok: false,
        msg: `Kalender-Verbindung konnte nicht gespeichert werden: ${(error as Error).message}`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function testCaldav() {
    if (!settings) return;
    const urlError = validateHttpUrl(settings.caldav.url, "CalDAV-URL");
    if (urlError) {
      setStatus({ ok: false, msg: urlError });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const response = await api.testCaldav({
        url: settings.caldav.url,
        username: settings.caldav.username,
        password: caldavPassword.trim() || undefined,
      });
      setStatus({
        ok: response.ok,
        msg: response.ok
          ? `Kalender erreichbar${response.status ? ` (HTTP ${response.status})` : ""}.`
          : `Kalender nicht erreichbar${response.status ? ` (HTTP ${response.status})` : ""}: ${response.error ?? "Unbekannter Fehler"}`,
      });
    } catch (error) {
      setStatus({ ok: false, msg: `Kalender-Test fehlgeschlagen: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function removeCaldavPassword() {
    setBusy(true);
    await api.deleteCaldavPassword();
    setSettings((current) => (current ? { ...current, caldav_password_set: false } : current));
    setStatus({ ok: true, msg: "Kalender-Passwort entfernt." });
    setBusy(false);
  }

  async function removeToken() {
    setBusy(true);
    await api.deleteHfToken();
    setSettings((current) => (current ? { ...current, hf_token_set: false } : current));
    setStatus(null);
    setBusy(false);
  }

  return {
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
    hardware,
    modelStatus,
    modelStatusLoading,
    selectedAsrEngine: asrEngineValue(settings?.asr_override),
    refreshModelStatus,
    refreshRecordingDevices,
    chooseDigestFolder,
    saveDictationShortcut,
    saveMeetingDetection,
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
  };
}
