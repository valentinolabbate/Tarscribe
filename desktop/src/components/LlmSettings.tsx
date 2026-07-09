import { type FocusEvent, type FormEvent, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { validateHttpUrl } from "../lib/formValidation";
import type { LlmProfile, LlmUseCase } from "../lib/types";
import {
  buildModelSelectOptions,
  KEY_PROVIDERS,
  type ModelSelectOption,
  NumField,
  PRESETS,
} from "./llm-settings/model";
import { ChevronDownIcon } from "./icons";

const USE_CASES: Array<{ id: LlmUseCase; label: string; detail: string }> = [
  { id: "chapters", label: "Kapitel", detail: "Zeitmarken und Kapitelüberschriften" },
  { id: "summaries", label: "Zusammenfassungen", detail: "Zusammenfassungen, Aufgaben und Digests" },
  { id: "chat", label: "Chat", detail: "Fragen an Aufnahmen und Wissensarchiv" },
];

const EMPTY_PROFILE: LlmProfile = {
  model: null,
  reasoning_effort: null,
  agent_mode: false,
  web_search: false,
};

type Profiles = Record<LlmUseCase, LlmProfile>;

function LlmModelDropdown({
  value,
  options,
  disabled,
  placeholder,
  emptyLabel,
  open,
  onOpenChange,
  onChange,
}: {
  value: string | null;
  options: ModelSelectOption[];
  disabled: boolean;
  placeholder: string;
  emptyLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string | null) => void;
}) {
  const selected = value ? options.find((option) => option.value === value) : null;
  const label = selected?.label ?? value ?? placeholder;

  function closeOnBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onOpenChange(false);
    }
  }

  function choose(next: string | null) {
    onChange(next);
    onOpenChange(false);
  }

  return (
    <div className={open ? "llm-model-dropdown open" : "llm-model-dropdown"} onBlur={closeOnBlur}>
      <button
        type="button"
        className="llm-model-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value || placeholder}
        onClick={() => onOpenChange(!open)}
      >
        <span>{label}</span>
        <ChevronDownIcon width={14} height={14} />
      </button>
      {open && (
        <div className="llm-model-menu" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className={!value ? "active" : ""}
            onClick={() => choose(null)}
          >
            {emptyLabel}
          </button>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "active" : ""}
              title={option.value}
              onClick={() => choose(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LlmSettings() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState(PRESETS.ollama);
  const [profiles, setProfiles] = useState<Profiles>({
    chapters: { ...EMPTY_PROFILE },
    summaries: { ...EMPTY_PROFILE },
    chat: { ...EMPTY_PROFILE },
  });
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [openModelMenu, setOpenModelMenu] = useState<LlmUseCase | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [temperature, setTemperature] = useState(0.3);
  const [topP, setTopP] = useState(0.9);
  const [useTopP, setUseTopP] = useState(false);
  const [topK, setTopK] = useState(40);
  const [useTopK, setUseTopK] = useState(false);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [useMaxTokens, setUseMaxTokens] = useState(false);
  const [chunkSize, setChunkSize] = useState(48000);
  const [agentLimits, setAgentLimits] = useState({
    max_rounds: 5,
    max_context_tokens: 12000,
    top_k: 6,
  });
  const baseUrlError = validateHttpUrl(baseUrl, "Base-URL");
  const showBaseUrlError = baseUrl.trim().length > 0 && !!baseUrlError;

  useEffect(() => {
    api.getLlmConfig().then((config) => {
      const nextProvider = config.provider || "ollama";
      const nextBaseUrl = config.base_url || PRESETS[nextProvider] || PRESETS.ollama;
      setProvider(nextProvider);
      setBaseUrl(nextBaseUrl);
      const fallback: LlmProfile = {
        model: config.model ?? null,
        reasoning_effort: config.reasoning_effort ?? null,
        agent_mode: false,
        web_search: false,
      };
      setProfiles({
        chapters: { ...fallback, ...config.profiles?.chapters },
        summaries: { ...fallback, ...config.profiles?.summaries },
        chat: { ...fallback, ...config.profiles?.chat },
      });
      if (config.temperature != null) setTemperature(config.temperature);
      if (config.top_p != null) {
        setTopP(config.top_p);
        setUseTopP(true);
      }
      if (config.top_k != null) {
        setTopK(config.top_k);
        setUseTopK(true);
      }
      if (config.max_tokens != null) {
        setMaxTokens(config.max_tokens);
        setUseMaxTokens(true);
      }
      const hasApiKey = !!config.api_key_set;
      if (hasApiKey) setApiKeySet(true);
      if (!KEY_PROVIDERS.has(nextProvider) || hasApiKey) {
        void loadModels(nextBaseUrl, { silent: true });
      }
    });
    api.getSettings().then((settings) => {
      if (settings.llm_chunk_size) setChunkSize(settings.llm_chunk_size);
      if (settings.agent_rag) setAgentLimits(settings.agent_rag);
    });
  }, []);

  async function loadModels(url = baseUrl, options: { silent?: boolean } = {}) {
    const urlError = validateHttpUrl(url, "Base-URL");
    if (urlError) {
      if (!options.silent) setStatus({ ok: false, msg: urlError });
      return;
    }
    setOpenModelMenu(null);
    setModelsLoading(true);
    setBusy(true);
    if (!options.silent) setStatus(null);
    try {
      if (apiKey.trim()) {
        const result = await api.setLlmApiKey(apiKey.trim(), url);
        setApiKeySet(true);
        if (!result.ok) {
          setModels([]);
          setModelsLoaded(false);
          setStatus({
            ok: false,
            msg: `Gespeichert, aber Verbindung fehlgeschlagen: ${result.error ?? ""}`,
          });
          return;
        }
        setApiKey("");
        setModels(result.models ?? []);
        setModelsLoaded(true);
        setStatus({ ok: true, msg: `${(result.models ?? []).length} Modelle gefunden` });
        return;
      }
      const result = await api.listLlmModels(url);
      setModels(result.models);
      setModelsLoaded(true);
      if (!options.silent) setStatus({ ok: true, msg: `${result.models.length} Modelle gefunden` });
    } catch (error) {
      setModels([]);
      setModelsLoaded(false);
      if (!options.silent) setStatus({ ok: false, msg: String((error as Error).message) });
    } finally {
      setModelsLoading(false);
      setBusy(false);
    }
  }

  async function removeApiKey() {
    setBusy(true);
    try {
      await api.deleteLlmApiKey();
      setApiKeySet(false);
      setApiKey("");
      setModels([]);
      setModelsLoaded(false);
      setOpenModelMenu(null);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function saveConnection() {
    if (baseUrlError) {
      setStatus({ ok: false, msg: baseUrlError });
      return;
    }
    await api.setLlmConfig({
      provider,
      base_url: baseUrl,
      temperature,
      top_p: useTopP ? topP : null,
      top_k: useTopK ? topK : null,
      max_tokens: useMaxTokens ? maxTokens : null,
    });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
    setStatus({ ok: true, msg: "Verbindung und gemeinsame Parameter gespeichert" });
  }

  async function updateProfile(useCase: LlmUseCase, patch: Partial<LlmProfile>) {
    const next = { ...profiles[useCase], ...patch };
    setProfiles((current) => ({ ...current, [useCase]: next }));
    await api.setLlmConfig({ profiles: { [useCase]: next } });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
  }

  async function saveChunkSize(size: number) {
    await api.updateSettings({ llm_chunk_size: size });
  }

  async function updateAgentLimits(patch: Partial<typeof agentLimits>) {
    const next = { ...agentLimits, ...patch };
    setAgentLimits(next);
    await api.updateSettings({ agent_rag: next });
  }

  function onProvider(nextProvider: string) {
    setProvider(nextProvider);
    if (PRESETS[nextProvider]) setBaseUrl(PRESETS[nextProvider]);
    setModels([]);
    setModelsLoaded(false);
    setOpenModelMenu(null);
    setStatus(null);
  }

  function onBaseUrlChange(value: string) {
    setBaseUrl(value);
    setModels([]);
    setModelsLoaded(false);
    setOpenModelMenu(null);
    setStatus(null);
  }

  function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadModels();
  }

  return (
    <div className="field llm-settings-field">
      <label>LLM-Verbindung</label>
      <div className="settings-info-box">
        Anbieter, Endpoint und Zugang gelten gemeinsam. Modell, Thinking-Level und
        Agent-Recherche stellst du darunter für jeden Einsatz separat ein.
      </div>
      <div className="seg llm-provider-toggle">
        {[
          ["ollama", "Ollama"],
          ["lmstudio", "LM Studio"],
          ["openai", "OpenAI"],
          ["openrouter", "OpenRouter"],
          ["custom", "Eigener Endpoint"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={provider === value ? "seg-btn active" : "seg-btn"}
            onClick={() => onProvider(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submitConnection} className="llm-endpoint-row">
        <input
          type="url"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          spellCheck={false}
          aria-invalid={showBaseUrlError}
          aria-describedby={showBaseUrlError ? "llm-base-url-error" : undefined}
        />
        <button className="btn" type="submit" disabled={busy || !!baseUrlError}>
          Modelle laden
        </button>
      </form>
      {showBaseUrlError && (
        <div id="llm-base-url-error" className="field-error">
          {baseUrlError}
        </div>
      )}
      {KEY_PROVIDERS.has(provider) && (
        <div className="llm-api-key-row">
          {apiKeySet && !apiKey ? (
            <>
              <span className="badge ready">✓ API-Key hinterlegt</span>
              <button className="btn ghost danger" onClick={removeApiKey} disabled={busy}>
                Entfernen
              </button>
            </>
          ) : (
            <input
              type="password"
              placeholder="API-Key (z.B. sk-…)"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          )}
        </div>
      )}
      {status && <div className={status.ok ? "llm-status ok" : "llm-status error"}>{status.msg}</div>}

      <div className="llm-profile-heading">
        <strong>Einsatz-Profile</strong>
        <span>Jeder Bereich kann ein anderes Modell und Rechenverhalten nutzen.</span>
      </div>
      <div className="llm-profile-grid">
        {USE_CASES.map((useCase) => {
          const profile = profiles[useCase.id];
          const modelOptions = buildModelSelectOptions(models, profile.model);
          const modelSelectDisabled = modelsLoading || (modelOptions.length === 0 && !profile.model);
          const modelPlaceholder = modelsLoading
            ? "Modelle werden geladen..."
            : modelsLoaded
              ? "Kein Modell"
              : "Modelle laden";
          return (
            <section className="llm-profile-card" key={useCase.id}>
              <div className="llm-profile-card-head">
                <strong>{useCase.label}</strong>
                <span>{useCase.detail}</span>
              </div>
              <label>
                Modell
                <LlmModelDropdown
                  value={profile.model}
                  options={modelOptions}
                  disabled={modelSelectDisabled}
                  placeholder={modelPlaceholder}
                  emptyLabel="Kein Modell"
                  open={openModelMenu === useCase.id}
                  onOpenChange={(nextOpen) => setOpenModelMenu(nextOpen ? useCase.id : null)}
                  onChange={(nextModel) => updateProfile(useCase.id, { model: nextModel })}
                />
              </label>
              <label>
                Thinking-Level
                <select
                  value={profile.reasoning_effort ?? ""}
                  onChange={(event) =>
                    updateProfile(useCase.id, {
                      reasoning_effort: event.target.value || null,
                    })
                  }
                >
                  <option value="">Aus (Modellstandard)</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Niedrig</option>
                  <option value="medium">Mittel</option>
                  <option value="high">Hoch</option>
                </select>
              </label>
              <label className={profile.agent_mode ? "llm-agent-toggle active" : "llm-agent-toggle"}>
                <input
                  type="checkbox"
                  checked={profile.agent_mode}
                  onChange={(event) =>
                    updateProfile(useCase.id, { agent_mode: event.target.checked })
                  }
                />
                <span>
                  <strong>Agent-Recherche</strong>
                  <small>Sucht iterativ im Wissensindex</small>
                </span>
              </label>
              <label className={profile.web_search ? "llm-agent-toggle active" : "llm-agent-toggle"}>
                <input
                  type="checkbox"
                  checked={profile.web_search}
                  onChange={(event) =>
                    updateProfile(useCase.id, { web_search: event.target.checked })
                  }
                />
                <span>
                  <strong>Websuche</strong>
                  <small>DuckDuckGo als externes Tool</small>
                </span>
              </label>
            </section>
          );
        })}
      </div>

      <div className="tuning llm-shared-tuning">
        <div className="llm-tuning-title">
          <strong>Gemeinsame Inferenz-Parameter</strong>
          <span>Diese Werte gelten weiterhin für alle drei Profile.</span>
        </div>
        <div className="tuning-row">
          <label>Temperature</label>
          <div className="llm-range-value">
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={temperature}
              onChange={(event) => setTemperature(Number(event.target.value))}
            />
            <span className="mono">{temperature.toFixed(2)}</span>
          </div>
        </div>
        <NumField
          label="Top-P"
          enabled={useTopP}
          onToggle={setUseTopP}
          value={topP}
          onChange={setTopP}
          min={0.01}
          max={1}
          step={0.05}
        />
        <NumField
          label="Top-K"
          enabled={useTopK}
          onToggle={setUseTopK}
          value={topK}
          onChange={setTopK}
          min={1}
          step={1}
          placeholder="z.B. 40"
        />
        <NumField
          label="Max. Tokens"
          enabled={useMaxTokens}
          onToggle={setUseMaxTokens}
          value={maxTokens}
          onChange={setMaxTokens}
          min={64}
          step={64}
          placeholder="z.B. 2048"
        />
        <div className="tuning-row">
          <label>Chunk-Größe (Zeichen)</label>
          <input
            type="number"
            min={4000}
            max={200000}
            step={1000}
            value={chunkSize}
            onChange={(event) => setChunkSize(Number(event.target.value))}
            onBlur={() => saveChunkSize(chunkSize)}
          />
        </div>
        <div className="llm-tuning-title llm-agent-limits-title">
          <strong>Grenzen der Agent-Recherche</strong>
          <span>Gemeinsames Sicherheits- und Kontextbudget für aktivierte Profile.</span>
        </div>
        <div className="tuning-row">
          <label>Maximale Suchrunden</label>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={agentLimits.max_rounds}
            onChange={(event) =>
              setAgentLimits((current) => ({ ...current, max_rounds: Number(event.target.value) }))
            }
            onBlur={() => updateAgentLimits({ max_rounds: agentLimits.max_rounds || 5 })}
          />
        </div>
        <div className="tuning-row">
          <label>Kontext-Token-Budget</label>
          <input
            type="number"
            min={1000}
            max={100000}
            step={500}
            value={agentLimits.max_context_tokens}
            onChange={(event) =>
              setAgentLimits((current) => ({
                ...current,
                max_context_tokens: Number(event.target.value),
              }))
            }
            onBlur={() =>
              updateAgentLimits({ max_context_tokens: agentLimits.max_context_tokens || 12000 })
            }
          />
        </div>
        <div className="tuning-row">
          <label>Treffer pro Suche</label>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={agentLimits.top_k}
            onChange={(event) =>
              setAgentLimits((current) => ({ ...current, top_k: Number(event.target.value) }))
            }
            onBlur={() => updateAgentLimits({ top_k: agentLimits.top_k || 6 })}
          />
        </div>
        <div className="llm-save-row">
          <button className="btn primary" onClick={saveConnection} disabled={!!baseUrlError}>
            Verbindung &amp; Parameter speichern
          </button>
        </div>
      </div>
    </div>
  );
}
