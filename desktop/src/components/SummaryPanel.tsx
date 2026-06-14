import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  useDeleteSummary,
  useLlmConfig,
  useSummaries,
  useSummaryProgress,
  useSummarize,
  useTemplates,
} from "../hooks/queries";
import { trackSummaryStart, useSummaryStream } from "../hooks/useJobs";
import { useUndoableDelete } from "../hooks/useUndoableDelete";
import type { SummaryTemplate } from "../lib/types";
import { ChevronIcon, TrashIcon } from "./icons";
import { useToast } from "./Toast";

// Remember the last picked template across recordings and sessions.
const LAST_TEMPLATE_KEY = "tarscribe:lastSummaryTemplateId";

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {children}
    </ReactMarkdown>
  );
}

/** First non-empty line, stripped of common Markdown markers, for collapsed cards. */
function previewLine(md: string): string {
  const line =
    md
      .split("\n")
      .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** Short, human-friendly description of what a template produces. */
function describeTemplate(t: SummaryTemplate): string {
  const text = t.system_prompt.trim() || t.user_prompt_template.trim();
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

export function SummaryPanel({
  recordingId,
  onOpenSettings,
}: {
  recordingId: number;
  onOpenSettings?: () => void;
}) {
  const toast = useToast();
  const { data: templates } = useTemplates();
  const { data: llm } = useLlmConfig();
  const { data: summaries } = useSummaries(recordingId, true);
  const summarize = useSummarize();
  const del = useDeleteSummary(recordingId);
  const undoDelete = useUndoableDelete();

  const [templateId, setTemplateId] = useState<number | null>(() => {
    const raw = localStorage.getItem(LAST_TEMPLATE_KEY);
    return raw ? Number(raw) : null;
  });
  const [activeSummaryId, setActiveSummaryId] = useState<number | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  // Saved summaries are collapsed by default; track which the user has opened.
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  function toggleExpanded(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  const stream = useSummaryStream(activeSummaryId);
  const { data: progress } = useSummaryProgress(recordingId, activeSummaryId, activeJobId);

  // Fall back to the first template if the remembered one no longer exists
  // (e.g. a built-in template that has since been retired).
  const rememberedValid = templateId != null && templates?.some((t) => t.id === templateId);
  const effectiveTemplate = (rememberedValid ? templateId : null) ?? templates?.[0]?.id ?? null;
  const activeTemplate = templates?.find((t) => t.id === effectiveTemplate) ?? null;
  const modelMissing = !llm?.model;

  function selectTemplate(id: number) {
    setTemplateId(id);
    localStorage.setItem(LAST_TEMPLATE_KEY, String(id));
  }

  async function copySummary(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      toast("Zusammenfassung in die Zwischenablage kopiert", "success");
    } catch {
      toast("Kopieren fehlgeschlagen", "error");
    }
  }

  async function run() {
    if (!effectiveTemplate) return;
    const res = await summarize.mutateAsync({ id: recordingId, templateId: effectiveTemplate });
    trackSummaryStart(res.summary_id);
    setActiveSummaryId(res.summary_id);
    setActiveJobId(res.job_id);
  }

  const polledText = progress?.summary.content ?? "";
  const streamedText = stream?.text ?? "";
  const text = streamedText.length >= polledText.length ? streamedText : polledText;
  const jobDone =
    progress?.job?.status === "done" ||
    progress?.job?.status === "failed" ||
    progress?.job?.status === "canceled";
  const streaming = activeSummaryId != null && !stream?.done && !jobDone;
  const streamError = stream?.error ?? (progress?.job?.status === "failed" ? progress.job.error : null);

  return (
    <div className="summary-panel">
      <div className="toolbar">
        <strong style={{ fontSize: 14 }}>Zusammenfassung</strong>
        <div className="spacer" />
        <select
          className="tmpl-sel"
          value={effectiveTemplate ?? ""}
          title={activeTemplate ? describeTemplate(activeTemplate) : undefined}
          onChange={(e) => selectTemplate(+e.target.value)}
        >
          {templates?.map((t) => (
            <option key={t.id} value={t.id} title={describeTemplate(t)}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={summarize.isPending || !!streaming || modelMissing || !effectiveTemplate}
          onClick={run}
          title={modelMissing ? "Erst ein LLM-Modell in den Einstellungen wählen" : ""}
        >
          {summarize.isPending ? "Startet…" : streaming ? "Generiere…" : "Zusammenfassen"}
        </button>
      </div>

      {activeTemplate && (
        <div className="summary-tmpl-desc rec-sub">{describeTemplate(activeTemplate)}</div>
      )}

      {modelMissing ? (
        <div className="summary-callout">
          <span>
            Kein LLM-Modell konfiguriert. Wähle in den Einstellungen Ollama oder LM Studio und ein
            Modell, um Zusammenfassungen zu erstellen.
          </span>
          {onOpenSettings && (
            <button className="btn" onClick={onOpenSettings}>
              Einstellungen öffnen
            </button>
          )}
        </div>
      ) : (
        activeSummaryId == null &&
        !summarize.isPending &&
        (summaries?.filter((s) => s.content).length ?? 0) === 0 && (
          <div className="summary-empty rec-sub">
            Noch keine Zusammenfassung. Wähle oben eine Vorlage und klicke „Zusammenfassen".
          </div>
        )
      )}

      {/* Live stream of the in-progress summary */}
      {summarize.isPending && !stream && (
        <div className="rec-sub" style={{ marginBottom: 8 }}>
          Zusammenfassung wird gestartet…
        </div>
      )}
      {activeSummaryId != null && (
        <div className="summary-card">
          {streamError ? (
            <div style={{ color: "var(--danger)" }}>{streamError}</div>
          ) : (
            <div className="summary-text markdown">
              {!text && streaming && <span className="rec-sub">Zusammenfassung wird erstellt… </span>}
              <Markdown>{text}</Markdown>
              {streaming && <span className="caret">▋</span>}
            </div>
          )}
        </div>
      )}

      {/* Saved summaries — collapsed by default, click the header to expand */}
      {summaries
        ?.filter((s) => s.content && s.id !== activeSummaryId && !undoDelete.isPending(s.id))
        .map((s) => {
          const open = expandedIds.has(s.id);
          return (
            <div className={`summary-card${open ? " open" : ""}`} key={s.id}>
              <div className="summary-head">
                <button
                  type="button"
                  className="summary-toggle"
                  aria-expanded={open}
                  title={open ? "Einklappen" : "Ausklappen"}
                  onClick={() => toggleExpanded(s.id)}
                >
                  <ChevronIcon className="summary-chevron" width={14} height={14} />
                  <span className="rec-sub">{s.model}</span>
                  {!open && <span className="summary-preview">{previewLine(s.content)}</span>}
                </button>
                <button
                  className="btn ghost"
                  style={{ padding: 4 }}
                  title="Kopieren"
                  onClick={() => copySummary(s.content)}
                >
                  Kopieren
                </button>
                <button
                  className="btn ghost danger"
                  style={{ padding: 4 }}
                  title="Löschen"
                  onClick={() =>
                    undoDelete.schedule(s.id, () => del.mutate(s.id), "Zusammenfassung gelöscht")
                  }
                >
                  <TrashIcon width={15} height={15} />
                </button>
              </div>
              {open && (
                <div className="summary-text markdown">
                  <Markdown>{s.content}</Markdown>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
