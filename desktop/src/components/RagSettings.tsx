import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { RagStatus } from "../lib/types";

const PRESETS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  openai: "https://api.openai.com/v1",
  custom: "",
};

const KEY_PROVIDERS = new Set(["openai", "custom"]);

export function RagSettings() {
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState(PRESETS.ollama);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [dimension, setDimension] = useState(768);
  const [topK, setTopK] = useState(6);
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [vecAvailable, setVecAvailable] = useState(true);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [indexStatus, setIndexStatus] = useState<RagStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getRagConfig().then((c) => {
      setEnabled(c.enabled ?? true);
      if (c.base_url) setBaseUrl(c.base_url);
      if (c.model) setModel(c.model);
      if (c.dimension) setDimension(c.dimension);
      if (c.top_k) setTopK(c.top_k);
      if (c.api_key_set) setApiKeySet(true);
      setVecAvailable(c.vec_available ?? true);
    });
    refreshIndexStatus();
  }, []);

  function refreshIndexStatus() {
    api.getRagStatus().then(setIndexStatus).catch(() => {});
  }

  async function loadModels(url = baseUrl) {
    setBusy(true);
    setStatus(null);
    try {
      if (apiKey.trim()) {
        const r = await api.setRagApiKey(apiKey.trim(), url);
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
      const res = await api.listRagModels(url);
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
      await api.deleteRagApiKey();
      setApiKeySet(false);
      setApiKey("");
    } finally {
      setBusy(false);
    }
  }

  async function save(next?: Partial<{ model: string; dimension: number; top_k: number; enabled: boolean }>) {
    await api.setRagConfig({
      base_url: baseUrl,
      model: next?.model ?? model,
      dimension: next?.dimension ?? dimension,
      top_k: next?.top_k ?? topK,
      enabled: next?.enabled ?? enabled,
    });
  }

  async function reindex() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.reindexRag();
      setStatus({ ok: true, msg: `${r.enqueued} Aufnahmen werden neu indiziert…` });
      setTimeout(refreshIndexStatus, 1500);
    } catch (e) {
      setStatus({ ok: false, msg: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  function onProvider(p: string) {
    setProvider(p);
    if (PRESETS[p] !== undefined && PRESETS[p]) setBaseUrl(PRESETS[p]);
  }

  return (
    <div className="field">
      <label>Wissens-Chat (RAG)</label>
      <div className="rec-sub" style={{ fontSize: 12, marginBottom: 8 }}>
        Transkripte und Zusammenfassungen werden eingebettet und durchsuchbar gemacht. Der
        Embedding-Endpoint wird unabhängig vom Chat-Modell konfiguriert.
      </div>

      {!vecAvailable && (
        <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 8 }}>
          sqlite-vec konnte nicht geladen werden — RAG ist auf diesem System nicht verfügbar.
        </div>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!vecAvailable}
          onChange={(e) => { setEnabled(e.target.checked); save({ enabled: e.target.checked }); }}
        />
        RAG-Indizierung aktiviert
      </label>

      <label style={{ fontSize: 12, color: "var(--text-faint)" }}>Embedding-Anbindung</label>
      <div className="seg" style={{ margin: "6px 0", flexWrap: "wrap" }}>
        {[
          ["ollama", "Ollama"],
          ["lmstudio", "LM Studio"],
          ["openai", "OpenAI"],
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
          onBlur={() => save()}
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
        </div>
      )}

      {models.length > 0 ? (
        <select
          value={model}
          onChange={(e) => { setModel(e.target.value); save({ model: e.target.value }); }}
          style={{ width: "100%" }}
        >
          <option value="">— Embedding-Modell wählen —</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input
          type="text"
          value={model}
          placeholder="Embedding-Modell (z.B. nomic-embed-text)"
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => save()}
          style={{ width: "100%" }}
          spellCheck={false}
        />
      )}

      <div className="tuning" style={{ marginTop: 12 }}>
        <div className="tuning-row">
          <label title="Vektor-Dimension des Embedding-Modells. Bei Änderung wird der Index neu aufgebaut.">
            Embedding-Dimension
          </label>
          <input
            type="number"
            min={64}
            step={1}
            value={dimension}
            style={{ width: 90 }}
            onChange={(e) => setDimension(Number(e.target.value))}
            onBlur={() => save({ dimension })}
          />
        </div>
        <div className="tuning-hint">
          Muss zum Modell passen (nomic-embed-text = 768, mxbai-embed-large = 1024). Eine
          Änderung verwirft den bestehenden Index — danach „Neu indizieren".
        </div>
        <div className="tuning-row">
          <label title="Wie viele Passagen pro Frage als Kontext abgerufen werden.">
            Abgerufene Passagen (Top-K)
          </label>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={topK}
            style={{ width: 90 }}
            onChange={(e) => setTopK(Number(e.target.value))}
            onBlur={() => save({ top_k: topK })}
          />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <button className="btn primary" disabled={busy || !vecAvailable || !enabled} onClick={reindex}>
          Alle Aufnahmen neu indizieren
        </button>
        {indexStatus && (
          <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
            {indexStatus.chunks} Passagen · {indexStatus.recordings_indexed} Aufnahmen
          </span>
        )}
      </div>

      {status && (
        <div style={{ marginTop: 8, fontSize: 12, color: status.ok ? "var(--ok)" : "var(--danger)" }}>
          {status.msg}
        </div>
      )}
    </div>
  );
}
