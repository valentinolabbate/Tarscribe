import { useCallback, useEffect, useRef, useState } from "react";
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

// Turn inline citation markers into clickable links (url "citation:1"). Handles
// single markers ([1]) as well as grouped ones the LLM tends to emit when more
// than one source backs a statement ([1, 2], [1,2,3]) — each number becomes its
// own clickable citation so multi-source references aren't lost.
function remarkCitations() {
  return (tree: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visit(tree as any, "text", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index == null || parent.type === "link") return;
      const value: string = node.value;
      const regex = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(value))) {
        if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
        const nums = match[1].split(",").map((n) => n.trim()).filter(Boolean);
        nums.forEach((n) => {
          parts.push({
            type: "link",
            url: `citation:${n}`,
            children: [{ type: "text", value: `[${n}]` }],
          });
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

function ChatMarkdown({
  text,
  onCite,
  validCites,
}: {
  text: string;
  onCite: (n: number) => void;
  /** Indices that map to a real source. Citations outside it render as plain
   *  text (the LLM sometimes cites a number with no matching source). When
   *  undefined (sources not yet known), every citation stays clickable. */
  validCites?: Set<number>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkCitations]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a({ href, children, ...props }) {
          if (href?.startsWith("citation:")) {
            const n = Number(href.slice("citation:".length));
            if (validCites && !validCites.has(n)) return <sup>{children}</sup>;
            return (
              <sup>
                <button type="button" className="cite-link" onClick={() => onCite(n)}>
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

// Persist chat history + the chosen mode per scope so both survive page switches
// and app restarts. Global chat and each recording's scoped chat get their own key.
const CHAT_HISTORY_LIMIT = 50;

interface PersistedChat {
  messages: UiMessage[];
  /** null = no stored preference yet (fall back to availability-based default). */
  mode: Mode | null;
}

function chatStorageKey(scope?: { id: number }): string {
  return scope ? `ts-chat-rec-${scope.id}` : "ts-chat-global";
}

function loadPersistedChat(key: string): PersistedChat {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { messages: [], mode: null };
    const parsed = JSON.parse(raw);
    // Tolerate the older array-only format as well as the {messages, mode} object.
    if (Array.isArray(parsed)) return { messages: parsed as UiMessage[], mode: null };
    return {
      messages: Array.isArray(parsed.messages) ? (parsed.messages as UiMessage[]) : [],
      mode: parsed.mode === "search" || parsed.mode === "chat" ? parsed.mode : null,
    };
  } catch {
    return { messages: [], mode: null };
  }
}

function sourceTypeLabel(t: RagSource["source_type"]): string {
  if (t === "summary") return "Zusammenfassung";
  if (t === "document") return "Dokument";
  return "Transkript";
}

function sourceMeta(s: RagSource | RagHit, withTitle: boolean): string {
  const parts: string[] = [];
  if (withTitle) parts.push(s.recording_title);
  parts.push(sourceTypeLabel(s.source_type));
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
  const storageKey = chatStorageKey(scopeRecording);
  // Restore persisted history + mode once at mount (kept in a ref so the
  // mount-only LLM-config effect can tell whether a mode preference was stored).
  const restored = useRef<PersistedChat>(loadPersistedChat(storageKey));
  const [mode, setMode] = useState<Mode>(() => restored.current.mode ?? "search");
  const [chatAvailable, setChatAvailable] = useState(false);

  const [messages, setMessages] = useState<UiMessage[]>(() => restored.current.messages);
  const [input, setInput] = useState("");
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [speakerFilter, setSpeakerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
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
    api
      .getLlmConfig()
      .then((c) => {
        const ok = !!c.model;
        setChatAvailable(ok);
        // Chat needs a model; otherwise force Search. When a model exists, respect
        // a restored preference and default to Chat only if none was stored.
        if (!ok) setMode("search");
        else if (restored.current.mode == null) setMode("chat");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (mode === "chat")
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, mode]);

  // Snapshot of what should be persisted; read by the debounced writer + unmount
  // flush so neither captures stale values.
  const persistState = useRef<{ key: string; messages: UiMessage[]; mode: Mode }>({
    key: storageKey,
    messages,
    mode,
  });
  persistState.current = { key: storageKey, messages, mode };

  const flushPersist = useCallback(() => {
    const { key, messages, mode } = persistState.current;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ messages: messages.slice(-CHAT_HISTORY_LIMIT), mode }),
      );
    } catch {
      /* ignore quota / serialization errors */
    }
  }, []);

  // Persist history + mode per scope. Writes are debounced so a streaming answer's
  // many deltas coalesce into a single write instead of hammering localStorage.
  // When the scope itself changes (a reused panel now points at a different
  // recording), load that conversation instead of writing the previous one over it.
  const keyRef = useRef(storageKey);
  useEffect(() => {
    if (keyRef.current !== storageKey) {
      keyRef.current = storageKey;
      const next = loadPersistedChat(storageKey);
      restored.current = next;
      setMessages(next.messages);
      if (next.mode) setMode(next.mode);
      return;
    }
    const timer = setTimeout(flushPersist, 400);
    return () => clearTimeout(timer);
  }, [messages, mode, storageKey, flushPersist]);

  // On unmount: stop any in-flight stream and flush the latest state immediately
  // (the debounce timer above is cancelled on unmount, so flush here too).
  useEffect(
    () => () => {
      abortRef.current?.abort();
      flushPersist();
    },
    [flushPersist],
  );

  const activeFilterCount =
    (speakerFilter.trim() ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);
  const scopeOpts = scoped
    ? { recordingId: scopeRecording!.id, speaker: speakerFilter.trim() || null }
    : {
        topicId: topicFilter,
        speaker: speakerFilter.trim() || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      };

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

  function clearChat() {
    abortRef.current?.abort();
    setStreaming(false);
    setOpenSnippet(null);
    setMessages([]);
  }

  const ragOff = status && !status.vec_available;

  function SourceAction({ s }: { s: RagSource | RagHit }) {
    if (s.source_type === "document" && s.document_id != null) {
      const docId = s.document_id;
      return (
        <button
          className="btn ghost"
          style={{ padding: "2px 8px", fontSize: 11.5 }}
          onClick={() => void api.openDocument(docId).catch(() => {})}
        >
          Dokument öffnen
        </button>
      );
    }
    if (s.recording_id == null) return null;
    const rec = s.recording_id;
    const start = s.start_sec;
    return (
      <button
        className="btn ghost"
        style={{ padding: "2px 8px", fontSize: 11.5 }}
        onClick={() => onOpenSource(rec, start)}
      >
        {scoped ? (start != null ? `▶ ${fmtDuration(start)}` : "▶ Abspielen") : "Aufnahme öffnen"}
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
        {mode === "chat" && messages.length > 0 && (
          <button
            className="btn ghost"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={clearChat}
            title="Diesen Chat-Verlauf löschen"
          >
            Neuer Chat
          </button>
        )}
        <button
          className={showFilters || activeFilterCount > 0 ? "btn ghost active" : "btn ghost"}
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => setShowFilters((v) => !v)}
        >
          Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
        {!scoped && (
          <>
            <select
              aria-label="Themenbereich"
              value={topicFilter ?? ""}
              onChange={(e) => setTopicFilter(e.target.value ? Number(e.target.value) : null)}
              style={{ maxWidth: 172 }}
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

      {showFilters && (
        <div className="search-filters">
          <label>
            Sprecher
            <input
              type="text"
              value={speakerFilter}
              onChange={(e) => setSpeakerFilter(e.target.value)}
              placeholder="z. B. Anna"
            />
          </label>
          {!scoped && (
            <>
              <label>
                Von
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </label>
              <label>
                Bis
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </label>
            </>
          )}
          {activeFilterCount > 0 && (
            <button
              className="btn ghost"
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={() => {
                setSpeakerFilter("");
                setDateFrom("");
                setDateTo("");
              }}
            >
              Zurücksetzen
            </button>
          )}
        </div>
      )}

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
                  <SourceAction s={h} />
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
                        validCites={m.sources ? new Set(m.sources.map((s) => s.index)) : undefined}
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
                        <SourceAction s={s} />
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
