import type { ReactNode } from "react";
import { PERFORMANCE_PROFILES } from "../../lib/performanceProfiles";
import type { AppSettings, HardwareInfo, ModelStatusPayload, PerformanceProfile } from "../../lib/types";
import {
  ASR_MODEL_SUGGESTIONS,
  DIARIZATION_MODEL_SUGGESTIONS,
  ModelStatusBadge,
  ModelStatusCard,
  activeModelStatus,
  activeRuntimeSummary,
  asrModelPlaceholder,
  findModelStatus,
  runtimeMemoryLabel,
  type AsrEngine,
} from "./settingsModel";

export function ModelsSettingsTab({
  settings,
  setSettings,
  hardware,
  modelStatus,
  modelStatusLoading,
  token,
  setToken,
  busy,
  secretStorageWarning,
  selectedAsrEngine,
  refreshModelStatus,
  savePerformanceProfile,
  saveAsrEngine,
  saveAsrModel,
  applyAsrSuggestion,
  saveDiarizationModel,
  applyDiarizationSuggestion,
  saveToken,
  removeToken,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  hardware: HardwareInfo | null;
  modelStatus: ModelStatusPayload | null;
  modelStatusLoading: boolean;
  token: string;
  setToken: (value: string) => void;
  busy: boolean;
  secretStorageWarning: ReactNode;
  selectedAsrEngine: AsrEngine;
  refreshModelStatus: () => void;
  savePerformanceProfile: (profile: PerformanceProfile) => void;
  saveAsrEngine: (engine: AsrEngine) => void;
  saveAsrModel: (value: string) => void;
  applyAsrSuggestion: (suggestion: (typeof ASR_MODEL_SUGGESTIONS)[number]) => void;
  saveDiarizationModel: (value: string) => void;
  applyDiarizationSuggestion: (suggestion: (typeof DIARIZATION_MODEL_SUGGESTIONS)[number]) => void;
  saveToken: () => void;
  removeToken: () => void;
}) {
  const modelItems = modelStatus?.items ?? [];
  const activeAsr = activeModelStatus(modelItems, "asr");
  const activeDiarization = activeModelStatus(modelItems, "diarization");
  const embeddingModel = findModelStatus(modelItems, "embedding", "speechbrain/spkrec-ecapa-voxceleb");
  const runtimeSummary = activeRuntimeSummary(modelItems, hardware?.memory_gb);

  return (
    <>
      <div className="settings-section-title model-status-title">
        <div>
          <span>Lokale Modelle</span>
          <small>Cache-Status für die aktuell genutzten lokalen Modelle.</small>
        </div>
        <button className="btn" onClick={refreshModelStatus} disabled={modelStatusLoading}>
          {modelStatusLoading ? "Prüfe…" : "Aktualisieren"}
        </button>
      </div>
      {runtimeSummary && (
        <div className="model-runtime-summary">
          <div className="model-runtime-copy">
            <strong>Aktive Modelle: {runtimeSummary.total}</strong>
            <span>{runtimeSummary.parts}</span>
          </div>
          {runtimeSummary.budgetPercent !== undefined && (
            <div
              className="model-runtime-budget"
              aria-label={`Modell-RAM-Budget ${runtimeSummary.budgetLabel}`}
              title={`Modell-RAM-Budget ${runtimeSummary.budgetLabel}`}
            >
              <span style={{ width: `${runtimeSummary.budgetPercent}%` }} />
            </div>
          )}
          {runtimeSummary.budgetLabel && <small>{runtimeSummary.budgetLabel}</small>}
        </div>
      )}
      <div className="model-status-grid">
        <ModelStatusCard title="Transkription" item={activeAsr} loading={modelStatusLoading} />
        <ModelStatusCard title="Diarisierung" item={activeDiarization} loading={modelStatusLoading} />
        <ModelStatusCard title="Sprecher-Matching" item={embeddingModel} loading={modelStatusLoading} />
      </div>
      <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
        Cache-Ordner: <code>{modelStatus?.models_dir ?? "wird ermittelt"}</code>
      </div>

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
            value={selectedAsrEngine}
            aria-label="Transkriptions-Engine"
            onChange={(event) => saveAsrEngine(event.target.value as AsrEngine)}
          >
            <option value="">Automatisch nach System</option>
            <option value="parakeet-mlx">Parakeet MLX</option>
            <option value="mlx-whisper">MLX Whisper</option>
            <option value="faster-whisper">faster-whisper</option>
          </select>
          <input
            type="text"
            list="asr-model-suggestions"
            value={settings.asr_model ?? ""}
            placeholder={asrModelPlaceholder(selectedAsrEngine)}
            onChange={(event) => setSettings({ ...settings, asr_model: event.target.value })}
            onBlur={(event) => saveAsrModel(event.target.value)}
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
            (suggestion) => !selectedAsrEngine || suggestion.engine === selectedAsrEngine,
          ).map((suggestion) => {
            const item = findModelStatus(modelItems, "asr", suggestion.model, suggestion.engine);
            const runtime = runtimeMemoryLabel(item);
            return (
              <button
                key={`${suggestion.engine}:${suggestion.model}`}
                type="button"
                className="suggestion-chip"
                onClick={() => applyAsrSuggestion(suggestion)}
              >
                <span>{suggestion.label}</span>
                <code>{suggestion.model}</code>
                <span className="suggestion-chip-foot">
                  <small>{suggestion.note}{runtime ? ` · ${runtime}` : ""}</small>
                  <ModelStatusBadge item={item} loading={modelStatusLoading} />
                </span>
              </button>
            );
          })}
        </div>
        {selectedAsrEngine === "faster-whisper" && hardware?.is_apple_silicon && (
          <div className="settings-info-box" style={{ marginTop: 8 }}>
            faster-whisper läuft auf diesem Mac über CPU. Für Whisper Large v3 auf Apple-GPU
            wähle MLX Whisper und den Vorschlag MLX Whisper Large v3.
          </div>
        )}
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Die Vorschläge füllen das Feld nur aus. MLX Whisper nutzt Apple-GPU/Metal;
          die volle Large-v3-Variante braucht mehr RAM als Turbo oder Parakeet.
        </div>
      </div>

      <div className="settings-section-title">
        <span>Diarisierung</span>
        <small>Sprechertrennung und pyannote-Modell.</small>
      </div>
      <div className="field">
        <label>Hugging Face Token</label>
        {secretStorageWarning}
        {settings.hf_token_set ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
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
              onChange={(event) => setToken(event.target.value)}
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
          onChange={(event) => setSettings({ ...settings, diarization_model: event.target.value })}
          onBlur={(event) => saveDiarizationModel(event.target.value)}
          spellCheck={false}
        />
        <datalist id="diarization-model-suggestions">
          {DIARIZATION_MODEL_SUGGESTIONS.map((suggestion) => (
            <option key={suggestion.model} value={suggestion.model} />
          ))}
        </datalist>
        <div className="suggestion-chips">
          {DIARIZATION_MODEL_SUGGESTIONS.map((suggestion) => {
            const item = findModelStatus(modelItems, "diarization", suggestion.model);
            const runtime = runtimeMemoryLabel(item);
            return (
              <button
                key={suggestion.model}
                type="button"
                className="suggestion-chip"
                onClick={() => applyDiarizationSuggestion(suggestion)}
              >
                <span>{suggestion.label}</span>
                <code>{suggestion.model}</code>
                <span className="suggestion-chip-foot">
                  <small>{suggestion.note}{runtime ? ` · ${runtime}` : ""}</small>
                  <ModelStatusBadge item={item} loading={modelStatusLoading} />
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 4, lineHeight: 1.5 }}>
          Vorschläge sind nur Startpunkte. Du kannst jedes kompatible pyannote-Modell oder
          einen eigenen Modellpfad eintragen.
        </div>
      </div>
    </>
  );
}
