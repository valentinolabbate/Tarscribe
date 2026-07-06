import { api } from "../../lib/api";
import { isTauri } from "../../lib/tauri";
import type { AppSettings } from "../../lib/types";
import { LlmSettings } from "../LlmSettings";

export function SummarySettingsTab({
  settings,
  setSettings,
  chooseDigestFolder,
  onShowTemplates,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  chooseDigestFolder: () => void;
  onShowTemplates: () => void;
}) {
  return (
    <>
      <LlmSettings />
      <div className="field">
        <label>Themenbereich-Wissen</label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.summary_use_topic_knowledge ?? true}
            onChange={(event) => {
              const next = event.target.checked;
              setSettings({ ...settings, summary_use_topic_knowledge: next });
              api.updateSettings({ summary_use_topic_knowledge: next });
            }}
          />
          <span>Relevantes Wissen aus dem Themenbereich in Zusammenfassungen einbeziehen</span>
        </label>
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Zieht passende Passagen aus anderen Transkripten, Zusammenfassungen und
          hochgeladenen Dateien desselben Themenbereichs hinzu. Benötigt aktiven Wissens-Chat (RAG).
        </div>
      </div>

      <div className="field">
        <label>Agentische Recherche ( experimentell)</label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.agent_rag_enabled ?? false}
            onChange={(event) => {
              const next = event.target.checked;
              setSettings({ ...settings, agent_rag_enabled: next });
              api.updateSettings({ agent_rag_enabled: next });
            }}
          />
          <span>LLM sucht aktiv iterativ im Wissensindex nach Kontext</span>
        </label>
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Das Chat-Modell nutzt native Tool-Calls, um mit gezielten Suchanfragen den
          Wissensindex zu durchsuchen, bis es genug Kontext gesammelt hat. Wirkt bei
          Zusammenfassungen, Aufgaben, Kapiteln, Diktat und Digest. Modelle ohne
          Tool-Unterstützung nutzen automatisch die einstufige Themenbereich-Anreicherung.
        </div>
        {settings.agent_rag_enabled && (
          <div className="tuning" style={{ marginTop: 10 }}>
            <div className="tuning-row">
              <label title="Maximale Anzahl Suchrunden, bevor die Recherche endet.">
                Maximale Suchrunden
              </label>
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                value={settings.agent_rag?.max_rounds ?? 5}
                style={{ width: 90 }}
                onChange={(event) => {
                  const value = Number(event.target.value) || 5;
                  const next = { ...settings.agent_rag, max_rounds: value };
                  setSettings({ ...settings, agent_rag: next });
                  api.updateSettings({ agent_rag: next });
                }}
              />
            </div>
            <div className="tuning-hint">
              Wie oft das Modell hintereinander suchen darf, bevor es die Recherche
              abschließt. Mehr Runden = gründlicher, aber langsamer.
            </div>
            <div className="tuning-row">
              <label title="Token-Budget für den gesammelten Kontext aus der Wissensbasis.">
                Kontext-Token-Budget
              </label>
              <input
                type="number"
                min={1000}
                max={100000}
                step={500}
                value={settings.agent_rag?.max_context_tokens ?? 12000}
                style={{ width: 90 }}
                onChange={(event) => {
                  const value = Number(event.target.value) || 12000;
                  const next = { ...settings.agent_rag, max_context_tokens: value };
                  setSettings({ ...settings, agent_rag: next });
                  api.updateSettings({ agent_rag: next });
                }}
              />
            </div>
            <div className="tuning-hint">
              Begrenzt den gesammelten Kontext aus der Wissensbasis. Bei Überschreitung
              stoppt die Recherche frühzeitig. Ca. 4 Zeichen ≈ 1 Token.
            </div>
            <div className="tuning-row">
              <label title="Anzahl Passagen pro Suchanfrage.">
                Treffer pro Suche (Top-K)
              </label>
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                value={settings.agent_rag?.top_k ?? 6}
                style={{ width: 90 }}
                onChange={(event) => {
                  const value = Number(event.target.value) || 6;
                  const next = { ...settings.agent_rag, top_k: value };
                  setSettings({ ...settings, agent_rag: next });
                  api.updateSettings({ agent_rag: next });
                }}
              />
            </div>
            <div className="tuning-hint">
              Wie viele Passagen pro Tool-Call zurückgegeben werden. Mehr Treffer = mehr
              Kontext pro Runde, aber höheres Token-Budget.
            </div>
          </div>
        )}
      </div>

      <div className="field">
        <label>Wochen-Digest Export-Ordner</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            placeholder="/Users/du/Obsidian/Wochen"
            value={settings.digest_export_path ?? ""}
            onChange={(event) => setSettings({ ...settings, digest_export_path: event.target.value })}
            onBlur={(event) => api.updateSettings({ digest_export_path: event.target.value.trim() })}
            style={{ flex: 1 }}
            spellCheck={false}
          />
          {isTauri() && (
            <button className="btn" onClick={chooseDigestFolder}>
              Durchsuchen…
            </button>
          )}
        </div>
        <div className="rec-sub" style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.5 }}>
          Dorthin schreibt Tarscribe den Wochen-Digest als Markdown, getrennt von den
          Themenbereich-Exporten.
        </div>
      </div>

      <div className="field">
        <label>Zusammenfassungs-Vorlagen</label>
        <button className="btn" onClick={onShowTemplates}>
          Vorlagen verwalten
        </button>
      </div>
    </>
  );
}
