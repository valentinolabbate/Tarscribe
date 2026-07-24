import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { validateHttpUrl } from "../../lib/formValidation";
import type { LlmConnection } from "../../lib/types";
import { KEY_PROVIDERS, PRESETS, PROVIDER_OPTIONS } from "./model";

export function ConnectionEditor({
  connection,
  isNew = false,
  usedBy,
  canDelete,
  modelState,
  onSave,
  onCancel,
  onDelete,
  onPersisted,
  onReload,
  onModelsLoaded,
}: {
  connection: LlmConnection;
  isNew?: boolean;
  usedBy: string[];
  canDelete: boolean;
  modelState?: { models: string[]; loaded: boolean; loading: boolean; error?: string };
  onSave: (connection: LlmConnection, apiKey: string) => Promise<LlmConnection>;
  onCancel?: () => void;
  onDelete?: () => Promise<void>;
  onPersisted?: () => void;
  onReload: () => void;
  onModelsLoaded: (connectionId: string, models: string[], error?: string) => void;
}) {
  const [draft, setDraft] = useState(connection);
  const [editing, setEditing] = useState(isNew);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    setDraft(connection);
  }, [connection]);

  const nameError = draft.name.trim() ? "" : "Name fehlt";
  const urlError = validateHttpUrl(draft.base_url, "Base-URL");
  const apiKeyRequired =
    KEY_PROVIDERS.has(draft.provider) &&
    draft.provider !== "custom" &&
    !connection.api_key_set &&
    !apiKey.trim();

  function changeProvider(provider: string) {
    setDraft((current) => ({
      ...current,
      provider,
      base_url: PRESETS[provider] ?? current.base_url,
    }));
    setStatus(null);
  }

  async function save() {
    if (nameError || urlError || apiKeyRequired) {
      setStatus({
        ok: false,
        msg: nameError || urlError || "Für diesen Anbieter ist ein API-Key erforderlich",
      });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const saved = await onSave(
        {
          ...draft,
          name: draft.name.trim(),
          base_url: draft.base_url.trim().replace(/\/+$/, ""),
        },
        apiKey.trim(),
      );
      setDraft(saved);
      setApiKey("");
      const result = await api.listLlmModels(undefined, saved.id);
      onModelsLoaded(saved.id, result.models);
      setStatus({ ok: true, msg: `${result.models.length} Modelle geladen` });
      setEditing(false);
      onPersisted?.();
    } catch (error) {
      const msg = String((error as Error).message);
      onModelsLoaded(draft.id, [], msg);
      setStatus({ ok: false, msg });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    setBusy(true);
    setStatus(null);
    try {
      await api.deleteLlmApiKey(draft.base_url);
      const saved = await onSave({ ...draft, api_key_set: false }, "");
      setDraft(saved);
      setApiKey("");
      onModelsLoaded(saved.id, []);
      setStatus({ ok: true, msg: "API-Key entfernt" });
    } catch (error) {
      setStatus({ ok: false, msg: String((error as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <article className="llm-connection-card compact">
        <div className="llm-connection-summary">
          <span
            className={
              modelState?.loading
                ? "llm-connection-state loading"
                : modelState?.error
                  ? "llm-connection-state error"
                  : "llm-connection-state ready"
            }
            aria-hidden="true"
          />
          <div className="llm-connection-identity">
            <strong>{connection.name}</strong>
            <span>{connection.base_url}</span>
          </div>
          <div className="llm-connection-meta">
            <span>{connection.provider}</span>
            <span>
              {modelState?.loading
                ? "Modelle werden geladen"
                : modelState?.error
                  ? "Nicht erreichbar"
                  : `${modelState?.models.length ?? 0} Modelle`}
            </span>
            {connection.api_key_set && <span>Key hinterlegt</span>}
          </div>
          {usedBy.length > 0 && (
            <div className="llm-connection-used-by" title={usedBy.join(", ")}>
              {usedBy.length} {usedBy.length === 1 ? "Einsatz" : "Einsätze"}
            </div>
          )}
          {modelState?.error && (
            <button type="button" className="btn ghost" onClick={onReload}>
              Erneut laden
            </button>
          )}
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Bearbeiten
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className={isNew ? "llm-connection-card new" : "llm-connection-card"}>
      <div className="llm-connection-card-head">
        <div>
          <strong>{isNew ? "Neue Verbindung" : connection.name}</strong>
          {!isNew && (
            <span>
              {connection.provider} · {connection.base_url}
            </span>
          )}
        </div>
        {!isNew && connection.api_key_set && <span className="badge ready">Key hinterlegt</span>}
      </div>

      <div className="llm-connection-fields">
        <label>
          Name
          <input
            value={draft.name}
            placeholder="z. B. OpenRouter Arbeit"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label>
          Anbieter
          <select value={draft.provider} onChange={(event) => changeProvider(event.target.value)}>
            {PROVIDER_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="llm-connection-url">
          Base-URL
          <input
            type="url"
            value={draft.base_url}
            spellCheck={false}
            aria-invalid={!!urlError}
            onChange={(event) =>
              setDraft((current) => ({ ...current, base_url: event.target.value }))
            }
          />
        </label>
        <label className="llm-connection-key">
          API-Key
          <input
            type="password"
            value={apiKey}
            placeholder={
              connection.api_key_set
                ? "Hinterlegt – nur zum Ersetzen ausfüllen"
                : draft.provider === "ollama" || draft.provider === "lmstudio"
                  ? "Optional für lokale Verbindung"
                  : "API-Key"
            }
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      </div>

      {usedBy.length > 0 && (
        <div className="llm-connection-usage">Verwendet für: {usedBy.join(", ")}</div>
      )}
      {status && <div className={status.ok ? "llm-status ok" : "llm-status error"}>{status.msg}</div>}

      <div className="llm-connection-actions">
        {!isNew && connection.api_key_set && (
          <button type="button" className="btn ghost danger" disabled={busy} onClick={removeKey}>
            Key entfernen
          </button>
        )}
        {!isNew && onDelete && (
          <button
            type="button"
            className="btn ghost danger"
            disabled={busy || !canDelete}
            title={canDelete ? "Verbindung löschen" : "Die Verbindung wird noch verwendet"}
            onClick={() => void onDelete()}
          >
            Löschen
          </button>
        )}
        <span />
        {onCancel && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
            Abbrechen
          </button>
        )}
        {!isNew && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>
            Schließen
          </button>
        )}
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Verbinde..." : "Speichern & Modelle laden"}
        </button>
      </div>
    </article>
  );
}
