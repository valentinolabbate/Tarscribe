import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const PRESETS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

export function LlmSettings() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState(PRESETS.ollama);
  const [model, setModel] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getLlmConfig().then((c) => {
      if (c.provider) setProvider(c.provider);
      if (c.base_url) setBaseUrl(c.base_url);
      if (c.model) setModel(c.model);
    });
  }, []);

  async function loadModels(url = baseUrl) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.listLlmModels(url);
      setModels(res.models);
      setStatus({ ok: true, msg: `${res.models.length} Modelle gefunden` });
    } catch (e) {
      setStatus({ ok: false, msg: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function save(nextModel = model) {
    await api.setLlmConfig({ provider, base_url: baseUrl, model: nextModel });
    qc.invalidateQueries({ queryKey: ["llm-config"] });
  }

  function onProvider(p: string) {
    setProvider(p);
    if (PRESETS[p]) setBaseUrl(PRESETS[p]);
  }

  return (
    <div className="field">
      <label>LLM für Zusammenfassungen</label>
      <div className="seg" style={{ marginBottom: 8 }}>
        {[
          ["ollama", "Ollama"],
          ["lmstudio", "LM Studio"],
          ["custom", "Custom"],
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
    </div>
  );
}
