import { useState, type ReactNode } from "react";
import { PERFORMANCE_PROFILES } from "../../lib/performanceProfiles";
import type { AppSettings, HardwareInfo, ModelStatusPayload, PerformanceProfile } from "../../lib/types";
import {
  ASR_ENGINE_LABELS, ASR_MODEL_SUGGESTIONS, ASR_PURPOSES, DIARIZATION_MODEL_SUGGESTIONS,
  ModelStatusBadge, ModelStatusCard, activeModelStatus, asrModelPlaceholder, asrPurpose,
  experimentalAsr, findModelStatus, type AsrEngine, type AsrPurpose,
} from "./settingsModel";

export function ModelsSettingsTab({
  settings, setSettings, hardware, modelStatus, modelStatusLoading, token, setToken,
  busy, secretStorageWarning, selectedAsrEngine, refreshModelStatus, savePerformanceProfile,
  saveAsrEngine, saveAsrModel, applyAsrSuggestion, saveDiarizationModel,
  applyDiarizationSuggestion, saveToken, removeToken, saveAsrOptions, prepareAsrModel,
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
  saveAsrOptions?: (patch: Partial<Pick<AppSettings, "language" | "asr_hotwords" | "live_asr_override">>) => void;
  prepareAsrModel?: () => void;
}) {
  const [purpose, setPurpose] = useState<AsrPurpose>(() => asrPurpose(selectedAsrEngine));
  const [search, setSearch] = useState("");
  const items = modelStatus?.items ?? [];
  const active = activeModelStatus(items, "asr");
  const chosen = ASR_MODEL_SUGGESTIONS.find((item) => item.engine === selectedAsrEngine
    && item.model === settings.asr_model);
  const experimental = experimentalAsr(selectedAsrEngine);
  const shown = ASR_MODEL_SUGGESTIONS.filter((item) =>
    (purpose === "all" || asrPurpose(item.engine) === purpose)
    && (item.label + " " + item.model).toLowerCase().includes(search.toLowerCase()));
  const needsLanguage = ["moss-mlx", "vibevoice-mlx", "vibevoice-bitnet"].includes(selectedAsrEngine);

  return <div className="model-settings">
    <section className="model-selection-summary" aria-label="Aktuelle Transkriptionsauswahl">
      <div>
        <span className="rec-sub">Aktuelle Transkription</span>
        <h3>{chosen?.label ?? (selectedAsrEngine ? ASR_ENGINE_LABELS[selectedAsrEngine] : "Automatisch nach System")}</h3>
        <p>{chosen?.note ?? "Tarscribe verwendet das zu deinem System passende Standardmodell."}</p>
      </div>
      <ModelStatusBadge item={active} loading={modelStatusLoading} />
      {experimental && <p className="model-caution">Experimentell. Noch kein Ersatz für die bewährten Standardmodelle.</p>}
      {active?.note && <p className="rec-sub">{active.note}</p>}
      {prepareAsrModel && <button type="button" className="btn" disabled={busy}
        onClick={prepareAsrModel}>{busy ? "Bitte warten…" : "Modell lokal vorbereiten"}</button>}
    </section>

    <section aria-labelledby="transcription-model-title">
      <div className="settings-section-title">
        <span id="transcription-model-title">Transkriptionsmodell wählen</span>
        <small>Nach Einsatzzweck filtern. Die Auswahl wird direkt gespeichert.</small>
      </div>
      <div className="model-purpose-filter" role="group" aria-label="Modelle nach Einsatzzweck">
        {ASR_PURPOSES.map((item) => <button key={item.id} type="button"
          className={purpose === item.id ? "active" : ""} aria-pressed={purpose === item.id}
          onClick={() => setPurpose(item.id)}>{item.label}</button>)}
      </div>
      <input className="model-search" type="search" aria-label="Modelle durchsuchen"
        placeholder="Modell suchen" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="model-choice-list" role="group" aria-label="Transkriptionsmodelle">
        {shown.map((item) => {
          const selected = item.engine === selectedAsrEngine && item.model === settings.asr_model;
          const unsupported = hardware !== null && !hardware.is_apple_silicon && experimentalAsr(item.engine);
          return <button key={item.engine + ":" + item.model} type="button" aria-pressed={selected}
            disabled={busy || unsupported} className={selected ? "model-choice selected" : "model-choice"}
            onClick={() => applyAsrSuggestion(item)}>
            <span className="model-choice-marker" aria-hidden="true">{selected ? "✓" : ""}</span>
            <span className="model-choice-copy"><strong>{item.label}</strong>
              <small>{unsupported ? "Benötigt Apple Silicon für die Wortausrichtung" : item.note}</small>
            </span>
            <span className="model-choice-meta">
              {experimentalAsr(item.engine) && <span className="model-experimental">Experimentell</span>}
              <ModelStatusBadge item={findModelStatus(items, "asr", item.model, item.engine)} loading={modelStatusLoading} />
            </span>
          </button>;
        })}
        {!shown.length && <p className="rec-sub">Kein Modell gefunden. Wähle „Alle“ oder ändere die Suche.</p>}
      </div>
      <button type="button" className="btn ghost" onClick={() => saveAsrEngine("")} disabled={busy}>
        Automatische Auswahl verwenden
      </button>
      {experimental && <div className="settings-info-box">
        {selectedAsrEngine === "nemotron-mlx"
          ? "Native Token-Zeitmarken und zustandsbehaftetes Live-Streaming ohne erneute Verarbeitung alter Audiofenster."
          : "Ein zusätzliches lokales Qwen-Modell richtet den Text wortgenau an der Aufnahme aus. Das benötigt zusätzliche Rechenzeit und Speicher."}
        {["moss-mlx", "vibevoice-mlx"].includes(selectedAsrEngine)
          && " Sprecherlabels gelten zunächst je Audioabschnitt. Für globale Sprecherzuordnung kannst du anschließend die separate Diarisierung starten."}
        {selectedAsrEngine === "vibevoice-bitnet"
          && " Die zusätzliche BitNet-Laufzeit ist in der macOS-App enthalten; im Entwicklungscheckout wird sie mit scripts/setup_bitnet.py gebaut."}
      </div>}
      {experimental && <div className="field">
        <label htmlFor="asr-language">Sprache für Transkription und Wortausrichtung</label>
        <select id="asr-language" value={settings.language ?? ""}
          onChange={(event) => saveAsrOptions?.({ language: event.target.value || null })}>
          <option value="">Automatisch</option>
          {[['de', 'Deutsch'], ['en', 'Englisch'], ['fr', 'Französisch'], ['es', 'Spanisch'],
            ['it', 'Italienisch'], ['pt', 'Portugiesisch'], ['ru', 'Russisch'], ['zh', 'Chinesisch'],
            ['ja', 'Japanisch'], ['ko', 'Koreanisch'], ['yue', 'Kantonesisch']]
            .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {needsLanguage && !settings.language && <p className="model-caution" role="status">
          Bitte eine Sprache wählen, bevor du dieses Modell verwendest.
        </p>}
      </div>}
    </section>

    <details className="model-settings-details">
      <summary>Modell während der Aufnahme</summary>
      <div className="field"><label htmlFor="live-asr-model">Live-Transkription</label>
        <select id="live-asr-model" value={settings.live_asr_override ?? ""}
          onChange={(event) => saveAsrOptions?.({ live_asr_override: event.target.value as AppSettings["live_asr_override"] })}>
          <option value="">Automatisch</option>
          <option value="parakeet-mlx" disabled={hardware !== null && !hardware.is_apple_silicon}>Parakeet (bewährt)</option>
          <option value="nemotron-mlx" disabled={hardware !== null && !hardware.is_apple_silicon}>Nemotron 3.5 (Streaming)</option>
          <option value="vibevoice-mlx" disabled={hardware !== null && !hardware.is_apple_silicon}>VibeVoice (Streaming mit Sprechern)</option>
        </select>
        <small>Unabhängig von der abschließenden Transkription. Automatisch verwendet bei Qwen, MOSS und BitNet das bewährte Systemmodell.</small>
        {settings.live_asr_override === "vibevoice-mlx" && <small>
          Live-Zeitmarken beziehen sich auf Audioabschnitte; die Wortausrichtung erfolgt nach der Aufnahme.
          Native Sprecherlabels ersetzen die separate Live-Diarisierung, ohne bekannte Stimmen zu identifizieren.
        </small>}
      </div>
    </details>

    <details className="model-settings-details">
      <summary>Erweiterte Transkriptionsoptionen</summary>
      <div className="field"><label htmlFor="asr-engine">Transkriptions-Engine</label>
        <select id="asr-engine" value={selectedAsrEngine} onChange={(event) => saveAsrEngine(event.target.value as AsrEngine)}>
          <option value="">Automatisch nach System</option>
          {Object.entries(ASR_ENGINE_LABELS).map(([engine, label]) => <option key={engine} value={engine}>{label}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="asr-model-id">Eigene Modell-ID oder lokaler Modellordner</label>
        <input id="asr-model-id" value={settings.asr_model ?? ""} placeholder={asrModelPlaceholder(selectedAsrEngine)}
          onChange={(event) => setSettings({ ...settings, asr_model: event.target.value })}
          onBlur={(event) => saveAsrModel(event.target.value)} spellCheck={false} />
        <small>Nur Modelle derselben Architektur sind kompatibel. Leer verwendet den Engine-Standard.</small>
      </div>
      <div className="field"><label htmlFor="asr-hotwords">Fachbegriffe und Namen</label>
        <textarea id="asr-hotwords" rows={3} defaultValue={(settings.asr_hotwords ?? []).join(", ")}
          placeholder="Begriffe durch Kommas trennen"
          onBlur={(event) => saveAsrOptions?.({ asr_hotwords: event.target.value.split(",").map((term) => term.trim()).filter(Boolean).slice(0, 100) })} />
        <small>Für Qwen, MOSS und VibeVoice. Die Begriffe bleiben lokal und garantieren keine bestimmte Schreibweise.</small>
      </div>
    </details>

    <details className="model-settings-details">
      <summary>Sprechertrennung und Hugging Face</summary>
      <p className="rec-sub">Separate Diarisierung für bewährte ASR-Modelle oder zur erneuten globalen Sprecherzuordnung.</p>
      <div className="field"><label htmlFor="diar-model">Diarisierungs-Modell</label>
        <select id="diar-model" value={DIARIZATION_MODEL_SUGGESTIONS.some((s) => s.model === settings.diarization_model) ? settings.diarization_model : "custom"}
          onChange={(event) => {
            const suggestion = DIARIZATION_MODEL_SUGGESTIONS.find((s) => s.model === event.target.value);
            if (suggestion) applyDiarizationSuggestion(suggestion);
            else setSettings({ ...settings, diarization_model: "" });
          }}>
          {DIARIZATION_MODEL_SUGGESTIONS.map((s) => <option key={s.model} value={s.model}>{s.label}</option>)}
          <option value="custom">Eigenes Modell</option>
        </select>
        <input aria-label="Eigene Diarisierungs-Modell-ID" value={settings.diarization_model}
          onChange={(event) => setSettings({ ...settings, diarization_model: event.target.value })}
          onBlur={(event) => saveDiarizationModel(event.target.value)} spellCheck={false} />
      </div>
      <div className="field"><label htmlFor="model-hf-token">Hugging Face Token</label>
        {secretStorageWarning}
        {settings.hf_token_set ? <div className="model-token-row">
          <span className="badge ready">Token hinterlegt</span>
          <button className="btn ghost danger" onClick={removeToken} disabled={busy}>Entfernen</button>
        </div> : <>
          <input id="model-hf-token" type="password" value={token} placeholder="hf_…"
            onChange={(event) => setToken(event.target.value)} spellCheck={false} autoComplete="off" />
          <button className="btn" onClick={saveToken} disabled={busy || !token.trim()}>Speichern & prüfen</button>
        </>}
        <small>Für pyannote-Downloads mit Zugangszustimmung. Speicherung ausschließlich im sicheren Secret-Speicher.</small>
      </div>
    </details>

    <details className="model-settings-details">
      <summary>Leistung und lokale Downloads</summary>
      <div className="field"><label htmlFor="model-profile">Laufzeitprofil</label>
        <select id="model-profile" value={settings.performance_profile}
          onChange={(event) => savePerformanceProfile(event.target.value as PerformanceProfile)}>
          {PERFORMANCE_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
        </select>
        <small>{hardware?.memory_gb ? hardware.memory_gb + " GB RAM verfügbar. " : ""}
          Eine explizite Modellwahl bleibt erhalten. Experimentelle Modelle haben noch keine verlässliche RAM-Schätzung.</small>
      </div>
      <div className="settings-section-title model-status-title"><span>Lokale Modelle</span>
        <button className="btn" onClick={refreshModelStatus} disabled={modelStatusLoading}>{modelStatusLoading ? "Prüfe…" : "Aktualisieren"}</button>
      </div>
      <div className="model-status-grid">
        <ModelStatusCard title="Transkription" item={active} loading={modelStatusLoading} />
        <ModelStatusCard title="Diarisierung" item={activeModelStatus(items, "diarization")} loading={modelStatusLoading} />
        <ModelStatusCard title="Sprecher-Matching" item={findModelStatus(items, "embedding", "speechbrain/spkrec-ecapa-voxceleb")} loading={modelStatusLoading} />
      </div>
      <p className="rec-sub model-cache-path">Cache-Ordner: <code>{modelStatus?.models_dir ?? "wird ermittelt"}</code></p>
      <p className="rec-sub">Fehlende Gewichte werden bei der ersten Nutzung geladen. Audiodaten werden nicht hochgeladen.</p>
    </details>
  </div>;
}
