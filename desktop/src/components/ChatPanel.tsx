import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { api } from "../lib/api";
import { fmtDuration } from "../lib/format";
import type { ChatMessage, RagSource, RagStatus, Topic } from "../lib/types";
import { ChatIcon, SearchIcon } from "./icons";

interface UiMessage extends ChatMessage {
  sources?: RagSource[];
}

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {children}
    </ReactMarkdown>
  );
}

export function ChatPanel({
  topics,
  onOpenSource,
}: {
  topics: Topic[];
  onOpenSource: (recordingId: number) => void;
}) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which source snippet is expanded, keyed by message + source index.
  const [openSnippet, setOpenSnippet] = useState<{ m: number; s: number } | null>(null);
  const [status, setStatus] = useState<RagStatus | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getRagStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);
    setInput("");

    const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const next: UiMessage[] = [
      ...messages,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ];
    setMessages(next);
    const assistantIdx = next.length - 1;

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    try {
      await api.ragChat(
        [...history, { role: "user", content: text }],
        { topicId: topicFilter },
        {
          signal: controller.signal,
          onSources: (s) =>
            setMessages((prev) => {
              const copy = [...prev];
              copy[assistantIdx] = { ...copy[assistantIdx], sources: s };
              return copy;
            }),
          onDelta: (d) =>
            setMessages((prev) => {
              const copy = [...prev];
              copy[assistantIdx] = {
                ...copy[assistantIdx],
                content: copy[assistantIdx].content + d,
              };
              return copy;
            }),
        },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(String((e as Error).message));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const ragOff = status && !status.vec_available;

  return (
    <div className="chat-panel" style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <ChatIcon width={18} height={18} />
        <strong>Wissens-Chat</strong>
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {status
            ? `${status.chunks} Passagen aus ${status.recordings_indexed} Aufnahmen`
            : "…"}
        </span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: "var(--text-faint)" }}>Bereich:</label>
        <select
          value={topicFilter ?? ""}
          onChange={(e) => setTopicFilter(e.target.value ? Number(e.target.value) : null)}
          style={{ maxWidth: 200 }}
        >
          <option value="">Alle Themenbereiche</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {ragOff && (
        <div style={{ fontSize: 13, color: "var(--danger)" }}>
          RAG ist nicht verfügbar (sqlite-vec konnte nicht geladen werden). Bitte in den
          Einstellungen prüfen.
        </div>
      )}

      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, paddingRight: 4 }}
      >
        {messages.length === 0 && !ragOff && (
          <div className="empty" style={{ margin: "auto", textAlign: "center" }}>
            <SearchIcon width={28} height={28} />
            <div className="big" style={{ marginTop: 8 }}>Frag deine Aufnahmen</div>
            <div style={{ color: "var(--text-faint)", maxWidth: 420 }}>
              Stelle Fragen über alle Transkripte und Zusammenfassungen hinweg. Antworten
              werden mit Quellen belegt.
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "82%" }}
          >
            <div
              className={m.role === "assistant" ? "markdown" : undefined}
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                background: m.role === "user" ? "var(--accent)" : "var(--bg-elevated)",
                color: m.role === "user" ? "var(--accent-ink)" : "var(--text)",
                border: m.role === "user" ? "none" : "1px solid var(--border)",
                whiteSpace: m.role === "user" ? "pre-wrap" : undefined,
                lineHeight: 1.55,
              }}
            >
              {m.role === "assistant" ? (
                m.content ? (
                  <Markdown>{m.content}</Markdown>
                ) : streaming && i === messages.length - 1 ? (
                  "…"
                ) : (
                  ""
                )
              ) : (
                m.content
              )}
            </div>
            {m.sources && m.sources.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {m.sources.map((s) => {
                  const open = openSnippet?.m === i && openSnippet?.s === s.index;
                  return (
                    <button
                      key={s.index}
                      className="badge"
                      title="Klicken: Textausschnitt anzeigen"
                      onClick={() =>
                        setOpenSnippet(open ? null : { m: i, s: s.index })
                      }
                      style={{
                        cursor: "pointer",
                        fontSize: 11.5,
                        borderColor: open ? "var(--accent)" : undefined,
                      }}
                    >
                      [{s.index}] {s.recording_title}
                      {s.start_sec != null ? ` · ${fmtDuration(s.start_sec)}` : ""}
                    </button>
                  );
                })}
              </div>
            )}
            {(() => {
              const s = m.sources?.find(
                (src) => openSnippet?.m === i && openSnippet?.s === src.index,
              );
              if (!s) return null;
              return (
                <div
                  style={{
                    marginTop: 6,
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "var(--bg-input)",
                    border: "1px solid var(--border)",
                    fontSize: 12.5,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 6,
                      color: "var(--text-faint)",
                      fontSize: 11.5,
                    }}
                  >
                    <span>
                      [{s.index}] {s.recording_title}
                      {s.source_type === "summary" ? " · Zusammenfassung" : ""}
                      {s.start_sec != null
                        ? ` · ${fmtDuration(s.start_sec)}${s.end_sec != null ? `–${fmtDuration(s.end_sec)}` : ""}`
                        : ""}
                    </span>
                    <div style={{ flex: 1 }} />
                    <button
                      className="btn ghost"
                      style={{ padding: "2px 8px", fontSize: 11.5 }}
                      onClick={() => onOpenSource(s.recording_id)}
                    >
                      Im Dokument öffnen
                    </button>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", color: "var(--text)", lineHeight: 1.5 }}>
                    {s.text}
                  </div>
                </div>
              );
            })()}
          </div>
        ))}
      </div>

      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Frage stellen… (Enter zum Senden, Shift+Enter für Zeilenumbruch)"
          rows={2}
          disabled={!!ragOff}
          style={{ flex: 1, resize: "none", fontFamily: "inherit" }}
        />
        {streaming ? (
          <button className="btn" onClick={stop}>Stop</button>
        ) : (
          <button className="btn primary" onClick={send} disabled={!input.trim() || !!ragOff}>
            Senden
          </button>
        )}
      </div>
    </div>
  );
}
