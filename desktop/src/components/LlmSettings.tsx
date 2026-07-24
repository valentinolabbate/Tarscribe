import { type FocusEvent, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LlmConnection, LlmProfile, LlmUseCase } from "../lib/types";
import { ConnectionEditor } from "./llm-settings/ConnectionEditor";
import {
  buildModelSelectOptions,
  type ModelSelectOption,
  NumField,
  PRESETS,
} from "./llm-settings/model";
import { ResearchChannelControls } from "./llm-settings/ResearchChannelControls";
import { ChevronDownIcon } from "./icons";

const USE_CASES: Array<{ id: LlmUseCase; label: string; detail: string }> = [
  { id: "chapters", label: "Kapitel", detail: "Zeitmarken und Kapitelüberschriften" },
  { id: "summaries", label: "Zusammenfassungen", detail: "Zusammenfassungen, Aufgaben und Digests" },
  { id: "chat", label: "Chat", detail: "Fragen an Aufnahmen und Wissensarchiv" },
];

type Profiles = Record<LlmUseCase, LlmProfile>;
type ConnectionModels = Record<
  string,
  { models: string[]; loaded: boolean; loading: boolean; error?: string }
>;

function emptyProfile(connectionId: string): LlmProfile {
  return {
    connection_id: connectionId,
    model: null,
    reasoning_effort: null,
    agent_mode: false,
    web_search: false,
  };
}

function LlmModelDropdown({
  value,
  options,
  disabled,
  placeholder,
  open,
  onOpenChange,
  onChange,
}: {
  value: string | null;
  options: ModelSelectOption[];
  disabled: boolean;
  placeholder: string;
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
            Kein Modell
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
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [newConnection, setNewConnection] = useState<LlmConnection | null>(null);
  const [profiles, setProfiles] = useState<Profiles>({
    chapters: emptyProfile(""),
    summaries: emptyProfile(""),
    chat: emptyProfile(""),
  });
  const [connectionModels, setConnectionModels] = useState<ConnectionModels>({});
  const [openModelMenu, setOpenModelMenu] = useState<LlmUseCase | null>(null);
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
  const [parameterStatus, setParameterStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadConfig();
    api.getSettings().then((settings) => {
      if (settings.llm_chunk_size) setChunkSize(settings.llm_chunk_size);
      if (settings.agent_rag) setAgentLimits(settings.agent_rag);
    });
  }, []);

  async function loadConfig() {
    const config = await api.getLlmConfig();
    const loadedConnections =
      config.connections && config.connections.length > 0
        ? config.connections
        : [
            {
              id: "local",
              name: "Lokale Standardverbindung",
              provider: config.provider || "ollama",
              base_url: config.base_url || PRESETS.ollama,
              api_key_set: config.api_key_set,
            },
          ];
    const firstId = loadedConnections[0].id;
    const fallback: LlmProfile = {
      ...emptyProfile(firstId),
      model: config.model ?? null,
      reasoning_effort: config.reasoning_effort ?? null,
    };
    setConnections(loadedConnections);
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
    for (const connection of loadedConnections) {
      void loadConnectionModels(connection.id);
    }
  }

  async function loadConnectionModels(connectionId: string) {
    setConnectionModels((current) => ({
      ...current,
      [connectionId]: {
        models: current[connectionId]?.models ?? [],
        loaded: false,
        loading: true,
      },
    }));
    try {
      const result = await api.listLlmModels(undefined, connectionId);
      setConnectionModels((current) => ({
        ...current,
        [connectionId]: { models: result.models, loaded: true, loading: false },
      }));
    } catch (error) {
      setConnectionModels((current) => ({
        ...current,
        [connectionId]: {
          models: [],
          loaded: true,
          loading: false,
          error: String((error as Error).message),
        },
      }));
    }
  }

  function modelsLoaded(connectionId: string, models: string[], error?: string) {
    setConnectionModels((current) => ({
      ...current,
      [connectionId]: { models, loaded: true, loading: false, error },
    }));
  }

  async function saveConnection(
    connection: LlmConnection,
    apiKey: string,
  ): Promise<LlmConnection> {
    const nextConnections = newConnection?.id === connection.id
      ? [...connections, connection]
      : connections.map((item) => (item.id === connection.id ? connection : item));
    let response = await api.setLlmConfig({ connections: nextConnections });
    let saved =
      response.connections?.find((item) => item.id === connection.id) ?? connection;
    if (apiKey) {
      const keyResult = await api.setLlmApiKey(apiKey, saved.base_url);
      saved = { ...saved, api_key_set: keyResult.api_key_set };
      response = await api.getLlmConfig();
    }
    const synced = response.connections ?? nextConnections;
    setConnections(
      synced.map((item) => (item.id === saved.id ? { ...item, api_key_set: saved.api_key_set } : item)),
    );
    qc.invalidateQueries({ queryKey: ["llm-config"] });
    return saved;
  }

  async function deleteConnection(connection: LlmConnection) {
    const next = connections.filter((item) => item.id !== connection.id);
    const response = await api.setLlmConfig({ connections: next });
    setConnections(response.connections ?? next);
    setConnectionModels((current) => {
      const nextModels = { ...current };
      delete nextModels[connection.id];
      return nextModels;
    });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
  }

  async function updateProfile(useCase: LlmUseCase, patch: Partial<LlmProfile>) {
    const next = { ...profiles[useCase], ...patch };
    setProfiles((current) => ({ ...current, [useCase]: next }));
    await api.setLlmConfig({ profiles: { [useCase]: next } });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
  }

  async function saveParameters() {
    await api.setLlmConfig({
      temperature,
      top_p: useTopP ? topP : null,
      top_k: useTopK ? topK : null,
      max_tokens: useMaxTokens ? maxTokens : null,
    });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
    setParameterStatus("Parameter gespeichert");
  }

  async function saveChunkSize(size: number) {
    await api.updateSettings({ llm_chunk_size: size });
  }

  async function updateAgentLimits(patch: Partial<typeof agentLimits>) {
    const next = { ...agentLimits, ...patch };
    setAgentLimits(next);
    await api.updateSettings({ agent_rag: next });
  }

  function usedBy(connectionId: string) {
    return USE_CASES.filter((useCase) => profiles[useCase.id].connection_id === connectionId).map(
      (useCase) => useCase.label,
    );
  }

  function addConnection() {
    setNewConnection({
      id: crypto.randomUUID(),
      name: "",
      provider: "ollama",
      base_url: PRESETS.ollama,
      api_key_set: false,
    });
  }

  return (
    <div className="field llm-settings-field">
      <div className="llm-section-heading">
        <div>
          <strong>LLM-Verbindungen</strong>
          <span>Endpoints und Zugangsdaten einmal speichern und danach wiederverwenden.</span>
        </div>
        <button type="button" className="btn" disabled={!!newConnection} onClick={addConnection}>
          + Verbindung
        </button>
      </div>

      <div className="llm-connection-list">
        {connections.map((connection) => {
          const usage = usedBy(connection.id);
          return (
            <ConnectionEditor
              key={connection.id}
              connection={connection}
              usedBy={usage}
              canDelete={connections.length > 1 && usage.length === 0}
              modelState={connectionModels[connection.id]}
              onSave={saveConnection}
              onDelete={() => deleteConnection(connection)}
              onReload={() => void loadConnectionModels(connection.id)}
              onModelsLoaded={modelsLoaded}
            />
          );
        })}
        {newConnection && (
          <ConnectionEditor
            connection={newConnection}
            isNew
            usedBy={[]}
            canDelete={false}
            modelState={connectionModels[newConnection.id]}
            onSave={saveConnection}
            onCancel={() => setNewConnection(null)}
            onPersisted={() => setNewConnection(null)}
            onReload={() => void loadConnectionModels(newConnection.id)}
            onModelsLoaded={modelsLoaded}
          />
        )}
      </div>

      <div className="llm-section-heading llm-assignments-heading">
        <div>
          <strong>Einsatz zuordnen</strong>
          <span>Modelle werden automatisch aus der gewählten Verbindung geladen.</span>
        </div>
      </div>

      <div className="llm-profile-grid">
        {USE_CASES.map((useCase) => {
          const profile = profiles[useCase.id];
          const modelState = connectionModels[profile.connection_id];
          const modelOptions = buildModelSelectOptions(
            modelState?.models ?? [],
            profile.model,
          );
          const modelPlaceholder = modelState?.loading
            ? "Modelle werden geladen..."
            : modelState?.error
              ? "Verbindung nicht erreichbar"
              : modelState?.loaded
                ? "Kein Modell"
                : "Modelle werden geladen...";
          return (
            <section className="llm-profile-card" key={useCase.id}>
              <div className="llm-profile-card-head">
                <strong>{useCase.label}</strong>
                <span>{useCase.detail}</span>
              </div>
              <label>
                Verbindung
                <select
                  value={profile.connection_id}
                  onChange={(event) => {
                    const connectionId = event.target.value;
                    setOpenModelMenu(null);
                    void updateProfile(useCase.id, {
                      connection_id: connectionId,
                      model: null,
                    });
                    if (!connectionModels[connectionId]) {
                      void loadConnectionModels(connectionId);
                    }
                  }}
                >
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Modell
                <LlmModelDropdown
                  value={profile.model}
                  options={modelOptions}
                  disabled={!!modelState?.loading || (modelOptions.length === 0 && !profile.model)}
                  placeholder={modelPlaceholder}
                  open={openModelMenu === useCase.id}
                  onOpenChange={(open) => setOpenModelMenu(open ? useCase.id : null)}
                  onChange={(model) => void updateProfile(useCase.id, { model })}
                />
              </label>
              <label>
                Thinking-Level
                <select
                  value={profile.reasoning_effort ?? ""}
                  onChange={(event) =>
                    void updateProfile(useCase.id, {
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
              <ResearchChannelControls
                knowledgeEnabled={profile.agent_mode}
                webEnabled={profile.web_search}
                profileLabel={useCase.label}
                onKnowledgeChange={(enabled) =>
                  void updateProfile(useCase.id, { agent_mode: enabled })
                }
                onWebChange={(enabled) =>
                  void updateProfile(useCase.id, { web_search: enabled })
                }
              />
            </section>
          );
        })}
      </div>

      <div className="tuning llm-shared-tuning">
        <div className="llm-tuning-title">
          <strong>Gemeinsame Inferenz-Parameter</strong>
          <span>Diese Werte gelten weiterhin für alle drei Einsätze.</span>
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
            onBlur={() => void saveChunkSize(chunkSize)}
          />
        </div>
        <div className="llm-tuning-title llm-agent-limits-title">
          <strong>Grenzen der Recherche</strong>
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
            onBlur={() => void updateAgentLimits({ max_rounds: agentLimits.max_rounds || 5 })}
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
              void updateAgentLimits({
                max_context_tokens: agentLimits.max_context_tokens || 12000,
              })
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
            onBlur={() => void updateAgentLimits({ top_k: agentLimits.top_k || 6 })}
          />
        </div>
        <div className="llm-save-row">
          {parameterStatus && <span className="llm-status ok">{parameterStatus}</span>}
          <button className="btn primary" onClick={() => void saveParameters()}>
            Parameter speichern
          </button>
        </div>
      </div>
    </div>
  );
}
