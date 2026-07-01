import { fmtDuration } from "../../lib/format";
import type { RagSource, Topic } from "../../lib/types";
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
}) {
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
          />
        </div>
      ))}
    </>
  );
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
  return (
    <div className="chat-source-row">
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
  );
}

function SourceSnippet({
  source,
  scoped,
  onOpenSource,
}: {
  source?: RagSource;
  scoped: boolean;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
}) {
  if (!source) return null;
  return (
    <div className="chat-source-snippet">
      <div className="chat-source-snippet-head">
        <span>
          [{source.index}] {sourceMeta(source, !scoped)}
        </span>
        <div className="chat-toolbar-spacer" />
        <SourceAction source={source} scoped={scoped} onOpenSource={onOpenSource} />
      </div>
      <div className="chat-source-snippet-text">{source.text}</div>
    </div>
  );
}
