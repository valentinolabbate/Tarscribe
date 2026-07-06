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
