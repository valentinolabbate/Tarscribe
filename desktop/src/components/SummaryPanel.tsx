import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  useDeleteSummary,
  useLlmConfig,
  useSummaries,
  useSummarize,
  useTemplates,
} from "../hooks/queries";
import { useSummaryStream } from "../hooks/useJobs";
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
  const stream = useSummaryStream(activeSummaryId);

  const effectiveTemplate = templateId ?? templates?.[0]?.id ?? null;
  const modelMissing = !llm?.model;

  async function run() {
    if (!effectiveTemplate) return;
    const res = await summarize.mutateAsync({ id: recordingId, templateId: effectiveTemplate });
    setActiveSummaryId(res.summary_id);
  }

  const streaming = stream && !stream.done;

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
          {streaming ? "Generiere…" : "Zusammenfassen"}
        </button>
      </div>

      {modelMissing && (
        <div className="rec-sub" style={{ color: "var(--warn)", marginBottom: 8 }}>
          Kein LLM-Modell konfiguriert — in den Einstellungen Ollama/LM Studio + Modell wählen.
        </div>
      )}

      {/* Live stream of the in-progress summary */}
      {stream && (
        <div className="summary-card">
          {stream.error ? (
            <div style={{ color: "var(--danger)" }}>{stream.error}</div>
          ) : (
            <div className="summary-text markdown">
              <Markdown>{stream.text}</Markdown>
              {!stream.done && <span className="caret">▋</span>}
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
