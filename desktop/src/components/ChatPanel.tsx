import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { visit } from "unist-util-visit";
import "katex/dist/katex.min.css";
import { api } from "../lib/api";
import { fmtDuration } from "../lib/format";
import type { ChatMessage, RagHit, RagSource, RagStatus, Topic } from "../lib/types";
import { ChatIcon, SearchIcon } from "./icons";

interface UiMessage extends ChatMessage {
  sources?: RagSource[];
}

type Mode = "search" | "chat";

// Turn inline citation markers like [1] into clickable links (url "citation:1").
function remarkCitations() {
  return (tree: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visit(tree as any, "text", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index == null || parent.type === "link") return;
      const value: string = node.value;
      const regex = /\[(\d+)\]/g;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(value))) {
        if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
        parts.push({
          type: "link",
          url: `citation:${match[1]}`,
          children: [{ type: "text", value: `[${match[1]}]` }],
        });
        last = match.index + match[0].length;
      }
      if (!parts.length) return;
      if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

function ChatMarkdown({ text, onCite }: { text: string; onCite: (n: number) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkCitations]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a({ href, children, ...props }) {
          if (href?.startsWith("citation:")) {
            return (
              <sup>
                <button
                  type="button"
                  className="cite-link"
                  onClick={() => onCite(Number(href.slice("citation:".length)))}
                >
                  {children}
                </button>
              </sup>
            );
          }
          return (
            <a href={href} {...props}>
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function sourceMeta(s: RagSource | RagHit, withTitle: boolean): string {
  const parts: string[] = [];
  if (withTitle) parts.push(s.recording_title);
  parts.push(s.source_type === "summary" ? "Zusammenfassung" : "Transkript");
  if (s.speaker) parts.push(s.speaker);
  if (s.start_sec != null)
    parts.push(`${fmtDuration(s.start_sec)}${s.end_sec != null ? `–${fmtDuration(s.end_sec)}` : ""}`);
  return parts.join(" · ");
}

export function ChatPanel({
  topics = [],
  scopeRecording,
  onOpenSource,
  embedded = false,
}: {
  topics?: Topic[];
  /** When set, search/chat are scoped to one recording (no topic filter). */
  scopeRecording?: { id: number; title: string };
  /** Global: open the recording. Scoped: seek the audio to startSec. */
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  embedded?: boolean;
}) {
  const scoped = !!scopeRecording;
  const [mode, setMode] = useState<Mode>("search");
  const [chatAvailable, setChatAvailable] = useState(false);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [openSnippet, setOpenSnippet] = useState<{ m: number; s: number } | null>(null);

  const [hits, setHits] = useState<RagHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getRagStatus().then(setStatus).catch(() => {});
    // Default to Chat only when a chat model is actually configured.
    api
      .getLlmConfig()
      .then((c) => {
        const ok = !!c.model;
        setChatAvailable(ok);
        setMode(ok ? "chat" : "search");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (mode === "chat")
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, mode]);

  const scopeOpts = scoped
    ? { recordingId: scopeRecording!.id }
    : { topicId: topicFilter };

  async function runSearch() {
    const q = input.trim();
    if (!q || searching) return;
    setError(null);
    setSearching(true);
    setHits(null);
    try {
      const res = await api.ragSearch(q, scopeOpts);
      setHits(res.hits);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSearching(false);
    }
  }

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
      await api.ragChat([...history, { role: "user", content: text }], scopeOpts, {
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
            copy[assistantIdx] = { ...copy[assistantIdx], content: copy[assistantIdx].content + d };
            return copy;
          }),
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(String((e as Error).message));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function submit() {
    if (mode === "search") runSearch();
    else send();
  }

  const ragOff = status && !status.vec_available;

  function SourceAction({ rec, start }: { rec: number; start?: number | null }) {
    return (
      <button
        className="btn ghost"
        style={{ padding: "2px 8px", fontSize: 11.5 }}
        onClick={() => onOpenSource(rec, start)}
      >
        {scoped ? (start != null ? `▶ ${fmtDuration(start)}` : "▶ Abspielen") : "Im Dokument öffnen"}
      </button>
    );
  }

  return (
    <div
      className={`chat-panel ${embedded ? "embedded" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        height: embedded ? "min(520px, calc(100vh - 405px))" : "100%",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {!embedded && <ChatIcon width={18} height={18} />}
        {!embedded && <strong>Wissens-Chat</strong>}
        {/* Mode toggle */}
        <div className="seg">
          <button
            className={mode === "search" ? "seg-btn active" : "seg-btn"}
            onClick={() => setMode("search")}
          >
            Suche
          </button>
          <button
            className={mode === "chat" ? "seg-btn active" : "seg-btn"}
            onClick={() => chatAvailable && setMode("chat")}
            disabled={!chatAvailable}
            title={chatAvailable ? "" : "Kein Chat-LLM konfiguriert (Einstellungen → Zusammenfassung)"}
          >
            Chat
          </button>
        </div>
        <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {scoped
            ? "Diese Aufnahme"
            : status
              ? `${status.chunks} Passagen · ${status.recordings_indexed} Aufnahmen`
              : "…"}
        </span>
        <div style={{ flex: 1 }} />
        {!scoped && (
          <>
            <label style={{ fontSize: 12, color: "var(--text-faint)" }}>Bereich:</label>
            <select
              value={topicFilter ?? ""}
              onChange={(e) => setTopicFilter(e.target.value ? Number(e.target.value) : null)}
              style={{ maxWidth: 180 }}
            >
              <option value="">Alle Themenbereiche</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {ragOff && (
        <div style={{ fontSize: 13, color: "var(--danger)" }}>
          RAG ist nicht verfügbar (sqlite-vec konnte nicht geladen werden). Bitte in den
          Einstellungen prüfen.
        </div>
      )}

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: mode === "search" ? 8 : 14,
          paddingRight: 4,
        }}
      >
        {/* ── Search mode ─────────────────────────────────────────────── */}
        {mode === "search" && (
          <>
            {hits === null && !searching && !ragOff && (
              <div className="empty" style={{ margin: "auto", textAlign: "center" }}>
                <SearchIcon width={28} height={28} />
                <div className="big" style={{ marginTop: 8 }}>
                  {scoped ? "Aufnahme durchsuchen" : "Aufnahmen durchsuchen"}
                </div>
                <div style={{ color: "var(--text-faint)", maxWidth: 420 }}>
                  Semantische Suche über {scoped ? "diese Aufnahme" : "alle Transkripte und Zusammenfassungen"}.
                  Findet passende Stellen auch ohne exakte Wortgleichheit — kein LLM nötig.
                </div>
              </div>
            )}
            {searching && <div style={{ color: "var(--text-faint)", margin: "auto" }}>Suche…</div>}
            {hits?.length === 0 && (
              <div style={{ color: "var(--text-faint)", margin: "auto" }}>Keine Treffer gefunden.</div>
            )}
            {hits?.map((h, idx) => (
              <div
                key={h.chunk_id}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                    fontSize: 11.5,
                    color: "var(--text-faint)",
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      color: "var(--accent)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    #{idx + 1}
                  </span>
                  <span>{sourceMeta(h, !scoped)}</span>
                  <div style={{ flex: 1 }} />
                  <SourceAction rec={h.recording_id} start={h.start_sec} />
                </div>
                <div style={{ whiteSpace: "pre-wrap", color: "var(--text)", lineHeight: 1.5, fontSize: 13 }}>
                  {h.text}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ── Chat mode ───────────────────────────────────────────────── */}
        {mode === "chat" && (
          <>
            {messages.length === 0 && !ragOff && (
              <div className="empty" style={{ margin: "auto", textAlign: "center" }}>
                <ChatIcon width={28} height={28} />
                <div className="big" style={{ marginTop: 8 }}>
                  {scoped ? "Diese Aufnahme fragen" : "Frag deine Aufnahmen"}
                </div>
                <div style={{ color: "var(--text-faint)", maxWidth: 420 }}>
                  Antworten werden aus {scoped ? "dieser Aufnahme" : "deinen Aufnahmen"} mit Quellen
                  belegt. Klicke auf eine [n]-Zitat-Marke, um die Belegstelle zu sehen.
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
                      <ChatMarkdown
                        text={m.content}
                        onCite={(n) => setOpenSnippet({ m: i, s: n })}
                      />
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
                          onClick={() => setOpenSnippet(open ? null : { m: i, s: s.index })}
                          style={{
                            cursor: "pointer",
                            fontSize: 11.5,
                            borderColor: open ? "var(--accent)" : undefined,
                          }}
                        >
                          [{s.index}] {scoped ? sourceMeta(s, false) : s.recording_title}
                          {!scoped && s.start_sec != null ? ` · ${fmtDuration(s.start_sec)}` : ""}
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
                          [{s.index}] {sourceMeta(s, !scoped)}
                        </span>
                        <div style={{ flex: 1 }} />
                        <SourceAction rec={s.recording_id} start={s.start_sec} />
                      </div>
                      <div style={{ whiteSpace: "pre-wrap", color: "var(--text)", lineHeight: 1.5 }}>
                        {s.text}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}
          </>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            mode === "search"
              ? "Suchbegriff oder Frage… (Enter zum Suchen)"
              : "Frage stellen… (Enter zum Senden, Shift+Enter = Zeilenumbruch)"
          }
          rows={2}
          disabled={!!ragOff}
          style={{ flex: 1, resize: "none", fontFamily: "inherit" }}
        />
        {mode === "chat" && streaming ? (
          <button className="btn" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={submit}
            disabled={!input.trim() || !!ragOff || searching}
          >
            {mode === "search" ? "Suchen" : "Senden"}
          </button>
        )}
      </div>
    </div>
  );
}
