import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTemplates } from "../hooks/queries";
import { api } from "../lib/api";
import type { SummaryTemplate } from "../lib/types";

const EMPTY = {
  name: "",
  system_prompt: "",
  user_prompt_template: "",
  output_format: "markdown",
  model_override: null as string | null,
};

export function TemplatesModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: templates } = useTemplates();
  const [selected, setSelected] = useState<SummaryTemplate | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY });
  const [creating, setCreating] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["templates"] });

  function edit(t: SummaryTemplate) {
    setSelected(t);
    setCreating(false);
    setDraft({
      name: t.name,
      system_prompt: t.system_prompt,
      user_prompt_template: t.user_prompt_template,
      output_format: t.output_format,
      model_override: t.model_override,
    });
  }
  function newTemplate() {
    setSelected(null);
    setCreating(true);
    setDraft({ ...EMPTY });
  }

  async function save() {
    if (creating) {
      await api.createTemplate(draft);
    } else if (selected) {
      await api.updateTemplate(selected.id, draft);
    }
    refresh();
    setCreating(false);
    setSelected(null);
  }
  async function duplicate(t: SummaryTemplate) {
    const copy = await api.duplicateTemplate(t.id);
    refresh();
    edit(copy);
  }
  async function remove(t: SummaryTemplate) {
    await api.deleteTemplate(t.id);
    refresh();
    setSelected(null);
  }

  const editing = creating || (selected && !selected.is_builtin);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal templates-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Zusammenfassungs-Vorlagen</h2>
        <div className="templates-grid">
          <div className="tmpl-list">
            {templates?.map((t) => (
              <button
                key={t.id}
                className={`tmpl-row ${selected?.id === t.id ? "active" : ""}`}
                onClick={() => edit(t)}
              >
                {t.name}
                {t.is_builtin && <span className="builtin-badge">Standard</span>}
              </button>
            ))}
            <button className="btn ghost" style={{ marginTop: 6 }} onClick={newTemplate}>
              + Neue Vorlage
            </button>
          </div>

          <div className="tmpl-editor">
            {!selected && !creating ? (
              <div className="rec-sub">Vorlage wählen oder neue erstellen.</div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="Name"
                  value={draft.name}
                  disabled={!editing}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <textarea
                  placeholder="System-Prompt"
                  rows={2}
                  value={draft.system_prompt}
                  disabled={!editing}
                  onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
                />
                <textarea
                  placeholder="User-Prompt (Platzhalter: {{transcript}} {{speakers}} {{topic}} {{date}})"
                  rows={7}
                  value={draft.user_prompt_template}
                  disabled={!editing}
                  onChange={(e) => setDraft({ ...draft, user_prompt_template: e.target.value })}
                />
                <div className="tmpl-actions">
                  {selected?.is_builtin && (
                    <span className="rec-sub">Standard-Vorlage — zum Anpassen duplizieren.</span>
                  )}
                  <div style={{ flex: 1 }} />
                  {selected && (
                    <button className="btn" onClick={() => duplicate(selected)}>Duplizieren</button>
                  )}
                  {selected && !selected.is_builtin && (
                    <button className="btn ghost danger" onClick={() => remove(selected)}>Löschen</button>
                  )}
                  {editing && (
                    <button className="btn primary" onClick={save} disabled={!draft.name.trim()}>
                      Speichern
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}
