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
import { TrashIcon } from "./icons";

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {children}
    </ReactMarkdown>
  );
}

export function SummaryPanel({ recordingId }: { recordingId: number }) {
  const { data: templates } = useTemplates();
  const { data: llm } = useLlmConfig();
  const { data: summaries } = useSummaries(recordingId, true);
  const summarize = useSummarize();
  const del = useDeleteSummary(recordingId);

  const [templateId, setTemplateId] = useState<number | null>(null);
  const [activeSummaryId, setActiveSummaryId] = useState<number | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const stream = useSummaryStream(activeSummaryId);
  const { data: progress } = useSummaryProgress(recordingId, activeSummaryId, activeJobId);

  const effectiveTemplate = templateId ?? templates?.[0]?.id ?? null;
  const modelMissing = !llm?.model;

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
          onChange={(e) => setTemplateId(+e.target.value)}
        >
          {templates?.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
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

      {modelMissing && (
        <div className="rec-sub" style={{ color: "var(--warn)", marginBottom: 8 }}>
          Kein LLM-Modell konfiguriert — in den Einstellungen Ollama/LM Studio + Modell wählen.
        </div>
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

      {/* Saved summaries */}
      {summaries
        ?.filter((s) => s.content && s.id !== activeSummaryId)
        .map((s) => (
          <div className="summary-card" key={s.id}>
            <div className="summary-head">
              <span className="rec-sub">{s.model}</span>
              <div style={{ flex: 1 }} />
              <button
                className="btn ghost"
                style={{ padding: 4 }}
                title="Kopieren"
                onClick={() => navigator.clipboard.writeText(s.content)}
              >
                Kopieren
              </button>
              <button className="btn ghost danger" style={{ padding: 4 }} onClick={() => del.mutate(s.id)}>
                <TrashIcon width={15} height={15} />
              </button>
            </div>
            <div className="summary-text markdown">
              <Markdown>{s.content}</Markdown>
            </div>
          </div>
        ))}
    </div>
  );
}
