import { useEffect, useRef, useState } from "react";
import { fmtDuration } from "../../lib/format";
import type { ChatResearchToolCall, RagSource, Topic } from "../../lib/types";
import { ChatIcon } from "../icons";
import { ChatContextUsage } from "./ChatContextUsage";
import { ChatMarkdown } from "./ChatMarkdown";
import { sourceMeta, type UiMessage } from "./model";
import { SourceAction } from "./SourceAction";

export function ChatModeView({
  messages,
  sessionLoading,
  chatAvailable,
  ragOff,
  scoped,
  streaming,
  prompts,
  topics,
  scopeRecording,
  openSnippet,
  onPrompt,
  onOpenSnippet,
  onOpenSource,
  onOpenDocument,
}: {
  messages: UiMessage[];
  sessionLoading: boolean;
  chatAvailable: boolean;
  ragOff: boolean;
  scoped: boolean;
  streaming: boolean;
  prompts: string[];
  topics: Topic[];
  scopeRecording?: { id: number; title: string };
  openSnippet: { m: number; s: number } | null;
  onPrompt: (prompt: string) => void;
  onOpenSnippet: (snippet: { m: number; s: number } | null) => void;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
}) {
  const [expandedResearch, setExpandedResearch] = useState<Set<number>>(() => new Set());

  return (
    <>
      {sessionLoading && <div style={{ color: "var(--text-faint)", margin: "auto" }}>Chat wird geladen...</div>}
      {!chatAvailable && !sessionLoading && !ragOff && (
        <div className="chat-config-callout">
          <ChatIcon width={20} height={20} />
          <div>
            <strong>Kein Chat-Modell konfiguriert</strong>
            <span>
              Wähle in den Einstellungen unter Zusammenfassung ein Chat-Modell. Die Suche bleibt ohne LLM nutzbar.
            </span>
          </div>
        </div>
      )}
      {messages.length === 0 && !sessionLoading && !ragOff && chatAvailable && (
        <div className="empty" style={{ margin: "auto", textAlign: "center" }}>
          <ChatIcon width={28} height={28} />
          <div className="big" style={{ marginTop: 8 }}>
            {scoped ? "Diese Aufnahme fragen" : "Frag deine Aufnahmen"}
          </div>
          <div style={{ color: "var(--text-faint)", maxWidth: 420 }}>
            Antworten werden aus {scoped ? "dieser Aufnahme" : "deinen Aufnahmen"} mit Quellen belegt.
            Klicke auf eine [n]-Zitat-Marke, um die Belegstelle zu sehen.
          </div>
          <div className="empty-action-row" aria-label="Chat-Beispiele">
            {prompts.map((prompt) => (
              <button className="btn ghost" key={prompt} onClick={() => onPrompt(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
      {messages.map((message, index) => (
        <div key={index} className={`chat-message-row ${message.role}`}>
          <div className={`chat-bubble ${message.role === "assistant" ? "markdown" : ""}`}>
            {message.role === "assistant" ? (
              message.content ? (
                <ChatMarkdown
                  text={message.content}
                  onCite={(number) => onOpenSnippet({ m: index, s: number })}
                  validCites={message.sources ? new Set(message.sources.map((source) => source.index)) : undefined}
                />
              ) : streaming && index === messages.length - 1 ? (
                "…"
              ) : (
                ""
              )
            ) : (
              message.content
            )}
          </div>
          {message.role === "assistant" && message.sources && (
            <ChatContextUsage sources={message.sources} topics={topics} scopeRecording={scopeRecording} />
          )}
          {message.role === "assistant" && message.agent_research && message.agent_research.length > 0 && (
            <ChatResearchUsage
              calls={message.agent_research}
              expanded={expandedResearch.has(index)}
              onToggle={() => {
                setExpandedResearch((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                });
              }}
            />
          )}
          {message.sources && message.sources.length > 0 && (
            <SourceBadges
              sources={message.sources}
              scoped={scoped}
              messageIndex={index}
              openSnippet={openSnippet}
              onOpenSnippet={onOpenSnippet}
            />
          )}
          <SourceSnippet
            source={message.sources?.find((source) => openSnippet?.m === index && openSnippet?.s === source.index)}
            scoped={scoped}
            onOpenSource={onOpenSource}
            onOpenDocument={onOpenDocument}
          />
        </div>
      ))}
    </>
  );
}

function ChatResearchUsage({
  calls,
  expanded,
  onToggle,
}: {
  calls: ChatResearchToolCall[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const hiddenCount = Math.max(0, calls.length - 3);
  const visibleCalls = expanded ? calls : calls.slice(-3);
  return (
    <div className="chat-research-usage" aria-label="Genutzte RAG-Toolaufrufe">
      <div className="chat-research-head">
        <span className="chat-context-label">RAG-Recherche:</span>
        <span className="chat-research-count">
          {calls.length} Toolcall{calls.length === 1 ? "" : "s"}
        </span>
        {hiddenCount > 0 && (
          <button type="button" className="chat-research-toggle" onClick={onToggle}>
            {expanded ? "Weniger" : `Erweitern (${hiddenCount})`}
          </button>
        )}
      </div>
      <div className="chat-research-list">
        {visibleCalls.map((call, index) => (
          <div key={`${call.round}-${call.query}-${index}`} className="chat-research-call">
            <span className="chat-research-query">{call.query || "…"}</span>
            <span className="chat-research-meta">
              {toolLabel(call.tool)} · {scopeLabel(call.scope)} ·{" "}
              {call.hits == null ? "sucht…" : `${call.hits} Treffer`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function toolLabel(tool: string): string {
  if (tool === "search_knowledge") return "Wissenssuche";
  if (tool === "search_web") return "Websuche";
  return tool || "Tool";
}

function scopeLabel(scope: string): string {
  if (scope === "all") return "Archiv";
  if (scope === "recording") return "Aufnahme";
  return "Thema";
}

function SourceBadges({
  sources,
  scoped,
  messageIndex,
  openSnippet,
  onOpenSnippet,
}: {
  sources: RagSource[];
  scoped: boolean;
  messageIndex: number;
  openSnippet: { m: number; s: number } | null;
  onOpenSnippet: (snippet: { m: number; s: number } | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const likelyOverflow = sources.length > 6;
  const canToggle = expanded || overflows || likelyOverflow;

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => setOverflows(row.scrollHeight > row.clientHeight + 1);
    const frame = window.requestAnimationFrame(measure);
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(row);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
    };
  }, [sources, expanded]);

  return (
    <div className="chat-source-group">
      <div ref={rowRef} className={`chat-source-row${expanded ? "" : " collapsed"}`}>
        {sources.map((source) => {
          const open = openSnippet?.m === messageIndex && openSnippet?.s === source.index;
          return (
            <button
              key={source.index}
              className="badge"
              title="Klicken: Textausschnitt anzeigen"
              onClick={() => onOpenSnippet(open ? null : { m: messageIndex, s: source.index })}
              style={{ cursor: "pointer", fontSize: 11.5, borderColor: open ? "var(--accent)" : undefined }}
            >
              [{source.index}] {scoped ? sourceMeta(source, false) : source.recording_title}
              {!scoped && source.start_sec != null ? ` · ${fmtDuration(source.start_sec)}` : ""}
            </button>
          );
        })}
      </div>
      {canToggle && (
        <button
          type="button"
          className="chat-source-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Quellen einklappen" : "Alle Quellen anzeigen"}
        </button>
      )}
    </div>
  );
}

function SourceSnippet({
  source,
  scoped,
  onOpenSource,
  onOpenDocument,
}: {
  source?: RagSource;
  scoped: boolean;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
}) {
  if (!source) return null;
  return (
    <div className="chat-source-snippet">
      <div className="chat-source-snippet-head">
        <span>
          [{source.index}] {sourceMeta(source, !scoped)}
        </span>
        <div className="chat-toolbar-spacer" />
        <SourceAction
          source={source}
          scoped={scoped}
          onOpenSource={onOpenSource}
          onOpenDocument={onOpenDocument}
        />
      </div>
      <div className="chat-source-snippet-text">{source.text}</div>
    </div>
  );
}
