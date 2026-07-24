import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { validateHttpUrl } from "../../lib/formValidation";
import { KEY_PROVIDERS, PRESETS } from "./model";

const PROVIDER_OPTIONS: Array<[string, string]> = [
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  ["custom", "Eigener Endpoint"],
];

export function ProfileConnection({
  profileProvider,
  profileBaseUrl,
  apiKeySet,
  globalProvider,
  globalBaseUrl,
  onConnectionChange,
  onModelsLoaded,
}: {
  profileProvider: string | null;
  profileBaseUrl: string | null;
  apiKeySet: boolean;
  globalProvider: string;
  globalBaseUrl: string;
  onConnectionChange: (patch: { provider: string | null; base_url: string | null }) => Promise<void>;
  onModelsLoaded: (models: string[]) => void;
}) {
  const custom = profileBaseUrl != null;
  const [provider, setProvider] = useState(profileProvider ?? globalProvider);
  const [baseUrl, setBaseUrl] = useState(profileBaseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [keySet, setKeySet] = useState(apiKeySet);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setProvider(profileProvider ?? globalProvider);
  }, [profileProvider, globalProvider]);
  useEffect(() => {
    setBaseUrl(profileBaseUrl ?? "");
  }, [profileBaseUrl]);
  useEffect(() => {
    setKeySet(apiKeySet);
  }, [apiKeySet]);

  const urlError = validateHttpUrl(baseUrl, "Base-URL");
  const showUrlError = baseUrl.trim().length > 0 && !!urlError;

  async function chooseProvider(next: string) {
    setProvider(next);
    const url = PRESETS[next] ?? baseUrl;
    setBaseUrl(url);
    setStatus(null);
    onModelsLoaded([]);
    await onConnectionChange({ provider: next, base_url: url.trim() || null });
  }

  async function saveBaseUrl() {
    const url = baseUrl.trim();
    if (!url || urlError || url === profileBaseUrl) return;
    onModelsLoaded([]);
    await onConnectionChange({ provider, base_url: url });
  }

  async function loadModels() {
    if (urlError || !baseUrl.trim()) {
      setStatus({ ok: false, msg: urlError || "Base-URL fehlt" });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (apiKey.trim()) {
        const result = await api.setLlmApiKey(apiKey.trim(), baseUrl.trim());
        setKeySet(true);
        if (!result.ok) {
          onModelsLoaded([]);
          setStatus({
            ok: false,
            msg: `Gespeichert, aber Verbindung fehlgeschlagen: ${result.error ?? ""}`,
          });
          return;
        }
        setApiKey("");
        onModelsLoaded(result.models ?? []);
        setStatus({ ok: true, msg: `${(result.models ?? []).length} Modelle gefunden` });
        return;
      }
      const result = await api.listLlmModels(baseUrl.trim());
      onModelsLoaded(result.models);
      setStatus({ ok: true, msg: `${result.models.length} Modelle gefunden` });
    } catch (error) {
      onModelsLoaded([]);
      setStatus({ ok: false, msg: String((error as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    setBusy(true);
    try {
      await api.deleteLlmApiKey(baseUrl.trim());
      setKeySet(false);
      setApiKey("");
      onModelsLoaded([]);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  if (!custom) {
    return (
      <button
        type="button"
        className="btn ghost profile-connection-toggle"
        onClick={() =>
          onConnectionChange({ provider: globalProvider, base_url: globalBaseUrl })
        }
      >
        Eigene Verbindung
      </button>
    );
  }

  return (
    <div className="profile-connection">
      <div className="profile-connection-head">
        <span>Eigene Verbindung</span>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            onModelsLoaded([]);
            void onConnectionChange({ provider: null, base_url: null });
          }}
        >
          Globale verwenden
        </button>
      </div>
      <div className="seg llm-provider-toggle">
        {PROVIDER_OPTIONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={provider === value ? "seg-btn active" : "seg-btn"}
            onClick={() => void chooseProvider(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="llm-endpoint-row">
        <input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          onBlur={() => void saveBaseUrl()}
          spellCheck={false}
          aria-invalid={showUrlError}
        />
        <button className="btn" type="button" disabled={busy || !baseUrl.trim() || !!urlError} onClick={() => void loadModels()}>
          Modelle laden
        </button>
      </div>
      {showUrlError && <div className="field-error">{urlError}</div>}
      {KEY_PROVIDERS.has(provider) && (
        <div className="llm-api-key-row">
          {keySet && !apiKey ? (
            <>
              <span className="badge ready">✓ API-Key hinterlegt</span>
              <button className="btn ghost danger" onClick={() => void removeKey()} disabled={busy}>
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
    </div>
  );
}
