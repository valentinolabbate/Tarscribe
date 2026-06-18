import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const PRESETS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// Providers that usually authenticate with an API key.
const KEY_PROVIDERS = new Set(["openai", "openrouter", "custom"]);

function NumField({
  label,
  enabled,
  onToggle,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
}: {
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max?: number;
  step: number;
  placeholder?: string;
}) {
  return (
    <div className="tuning-row">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />{" "}
        {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={!enabled}
        placeholder={placeholder}
        style={{ width: 80, opacity: enabled ? 1 : 0.4 }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function LlmSettings() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState(PRESETS.ollama);
  const [model, setModel] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // API key (secret) for hosted OpenAI-compatible providers.
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);

  // Inference params
  const [temperature, setTemperature] = useState(0.3);
  const [topP, setTopP] = useState(0.9);
  const [useTopP, setUseTopP] = useState(false);
  const [topK, setTopK] = useState(40);
  const [useTopK, setUseTopK] = useState(false);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [useMaxTokens, setUseMaxTokens] = useState(false);
  // Reasoning/"thinking" depth ("" = off / model default).
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [chunkSize, setChunkSize] = useState(48000);

  useEffect(() => {
    api.getLlmConfig().then((c) => {
      if (c.provider) setProvider(c.provider);
      if (c.base_url) setBaseUrl(c.base_url);
      if (c.model) setModel(c.model);
      if (c.temperature != null) setTemperature(c.temperature);
      if (c.top_p != null) { setTopP(c.top_p); setUseTopP(true); }
      if (c.top_k != null) { setTopK(c.top_k); setUseTopK(true); }
      if (c.max_tokens != null) { setMaxTokens(c.max_tokens); setUseMaxTokens(true); }
      if (c.reasoning_effort) setReasoningEffort(c.reasoning_effort);
      if (c.api_key_set) setApiKeySet(true);
    });
    api.getSettings().then((s) => {
      if (s.llm_chunk_size) setChunkSize(s.llm_chunk_size);
    });
  }, []);

  async function loadModels(url = baseUrl) {
    setBusy(true);
    setStatus(null);
    try {
      // If the user typed a new key, store + verify it (also returns the models).
      if (apiKey.trim()) {
        const r = await api.setLlmApiKey(apiKey.trim(), url);
        setApiKeySet(true);
        if (!r.ok) {
          setStatus({ ok: false, msg: `Gespeichert, aber Verbindung fehlgeschlagen: ${r.error ?? ""}` });
          return;
        }
        setApiKey("");
        setModels(r.models ?? []);
        setStatus({ ok: true, msg: `${(r.models ?? []).length} Modelle gefunden` });
        return;
      }
      const res = await api.listLlmModels(url);
      setModels(res.models);
      setStatus({ ok: true, msg: `${res.models.length} Modelle gefunden` });
    } catch (e) {
      setStatus({ ok: false, msg: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function removeApiKey() {
    setBusy(true);
    try {
      await api.deleteLlmApiKey();
      setApiKeySet(false);
      setApiKey("");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function save(nextModel = model) {
    await api.setLlmConfig({
      provider,
      base_url: baseUrl,
      model: nextModel,
      temperature,
      top_p: useTopP ? topP : null,
      top_k: useTopK ? topK : null,
      max_tokens: useMaxTokens ? maxTokens : null,
      reasoning_effort: reasoningEffort || null,
    });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
  }

  async function saveReasoning(v: string) {
    setReasoningEffort(v);
    // Partial update — backend only touches fields that are explicitly sent.
    await api.setLlmConfig({ reasoning_effort: v || null });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
  }

  async function saveChunkSize(size: number) {
    await api.updateSettings({ llm_chunk_size: size });
  }

  function onProvider(p: string) {
    setProvider(p);
    if (PRESETS[p]) setBaseUrl(PRESETS[p]);
  }

  return (
    <div className="field">
      <label>Chat-Modell (Zusammenfassungen &amp; Chat)</label>
      <div className="seg" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        {[
          ["ollama", "Ollama"],
          ["lmstudio", "LM Studio"],
          ["openai", "OpenAI"],
          ["openrouter", "OpenRouter"],
          ["custom", "Eigener Endpoint"],
        ].map(([v, l]) => (
          <button key={v} className={provider === v ? "seg-btn active" : "seg-btn"} onClick={() => onProvider(v)}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          style={{ flex: 1 }}
          spellCheck={false}
        />
        <button className="btn" disabled={busy} onClick={() => loadModels()}>
          Modelle laden
        </button>
      </div>

      {KEY_PROVIDERS.has(provider) && (
        <div style={{ marginBottom: 8 }}>
          {apiKeySet && !apiKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
              <span className="badge ready">✓ API-Key hinterlegt</span>
              <button className="btn ghost danger" onClick={removeApiKey} disabled={busy}>
                Entfernen
              </button>
            </div>
          ) : (
            <input
              type="password"
              placeholder="API-Key (z.B. sk-…)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              style={{ width: "100%" }}
            />
          )}
          <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
            Für Anbieter mit API-Key. Wird beim Klick auf „Modelle laden"
            gespeichert &amp; geprüft und sicher in der OS-Keychain abgelegt.
          </div>
        </div>
      )}
      {models.length > 0 && (
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            save(e.target.value);
          }}
          style={{ width: "100%" }}
        >
          <option value="">— Modell wählen —</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}
      {model && models.length === 0 && (
        <div className="rec-sub" style={{ fontSize: 12 }}>Aktuelles Modell: {model}</div>
      )}
      {status && (
        <div style={{ marginTop: 8, fontSize: 12, color: status.ok ? "var(--ok)" : "var(--danger)" }}>
          {status.msg}
        </div>
      )}

      {/* ── Inference-Parameter ─────────────────────────────────────────── */}
      <div className="tuning" style={{ marginTop: 12 }}>
        <div className="tuning-row">
          <label>Temperature</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              onMouseUp={() => save()}
              onTouchEnd={() => save()}
              style={{ width: 120 }}
            />
            <span className="mono" style={{ width: 34 }}>{temperature.toFixed(2)}</span>
          </div>
        </div>
        <div className="tuning-hint">
          Niedriger = deterministischer. Für Zusammenfassungen 0.1–0.5 empfohlen.
        </div>

        <NumField
          label="Top-P"
          enabled={useTopP}
          onToggle={(v) => { setUseTopP(v); save(); }}
          value={topP}
          onChange={(v) => setTopP(v)}
          min={0.01}
          max={1}
          step={0.05}
        />
        <NumField
          label="Top-K"
          enabled={useTopK}
          onToggle={(v) => { setUseTopK(v); save(); }}
          value={topK}
          onChange={(v) => setTopK(v)}
          min={1}
          step={1}
          placeholder="z.B. 40"
        />
        <NumField
          label="Max. Tokens"
          enabled={useMaxTokens}
          onToggle={(v) => { setUseMaxTokens(v); save(); }}
          value={maxTokens}
          onChange={(v) => setMaxTokens(v)}
          min={64}
          step={64}
          placeholder="z.B. 2048"
        />

        <div className="tuning-row" style={{ marginTop: 6 }}>
          <label title="Denk-/Reasoning-Tiefe für Chat und Zusammenfassungen. Wird nur an das Modell gesendet, wenn nicht Aus gewählt ist.">
            Reasoning / Thinking-Level
          </label>
          <select
            value={reasoningEffort}
            onChange={(e) => saveReasoning(e.target.value)}
            style={{ width: 130 }}
          >
            <option value="">Aus (Standard)</option>
            <option value="minimal">Minimal</option>
            <option value="low">Niedrig</option>
            <option value="medium">Mittel</option>
            <option value="high">Hoch</option>
          </select>
        </div>
        <div className="tuning-hint">
          Nur für Reasoning-fähige Modelle (z.B. GPT-5/o-Serie, gpt-oss, DeepSeek-R1).
          Höher = gründlicher, aber langsamer. Gilt für Chat &amp; Zusammenfassungen.
        </div>

        <div className="tuning-row" style={{ marginTop: 6 }}>
          <label title="Maximale Transkript-Zeichen pro LLM-Aufruf. Längere Texte werden in Abschnitte aufgeteilt.">
            Chunk-Größe (Zeichen)
          </label>
          <input
            type="number"
            min={4000}
            max={200000}
            step={1000}
            value={chunkSize}
            style={{ width: 90 }}
            onChange={(e) => setChunkSize(Number(e.target.value))}
            onBlur={() => saveChunkSize(chunkSize)}
          />
        </div>
        <div className="tuning-hint">
          Längere Texte werden in Abschnitte aufgeteilt (Map-Reduce). Default: 48 000.
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn primary" onClick={() => save()}>
            Parameter speichern
          </button>
        </div>
      </div>
    </div>
  );
}
