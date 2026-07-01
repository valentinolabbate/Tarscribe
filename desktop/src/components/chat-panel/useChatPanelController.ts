import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { ChatMessage, ChatScope, ChatSession, RagHit, RagSource, RagStatus } from "../../lib/types";
import {
  CHAT_HISTORY_LIMIT,
  chatStorageKey,
  loadPersistedChat,
  shortChatTitle,
  uiMessagesFromSession,
  type Mode,
  type PersistedChat,
  type ReasoningEffort,
  type UiMessage,
} from "./model";

export function useChatPanelController({
  scopeRecording,
}: {
  scopeRecording?: { id: number; title: string };
}) {
  const scopedRecordingId = scopeRecording?.id ?? null;
  const scopedRecordingTitle = scopeRecording?.title ?? null;
  const scoped = scopedRecordingId != null;
  const storageKey = chatStorageKey(scopeRecording);
  const chatScope: ChatScope = scoped ? "recording" : "global";
  const restored = useRef<PersistedChat>(loadPersistedChat(storageKey));
  const [mode, setMode] = useState<Mode>(() => restored.current.mode ?? "search");
  const [chatAvailable, setChatAvailable] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [speakerFilter, setSpeakerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [includeTopicContext, setIncludeTopicContext] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("");
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
      .then((config) => {
        const ok = !!config.model;
        setChatAvailable(ok);
        if (ok && restored.current.mode == null) setMode("chat");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (mode === "chat") {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, mode]);

  const loadChatSession = useCallback(async (chatId: number) => {
    setSessionLoading(true);
    setError(null);
    try {
      const chat = await api.getChatSession(chatId);
      setActiveSessionId(chat.id);
      setMessages(uiMessagesFromSession(chat));
      setOpenSnippet(null);
      setSessions((prev) => {
        const rest = prev.filter((session) => session.id !== chat.id);
        return [{ ...chat, messages: undefined }, ...rest].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
      });
    } catch (error) {
      setError(String((error as Error).message));
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    setIncludeTopicContext(false);
    let cancelled = false;
    const legacy = loadPersistedChat(storageKey);
    restored.current = legacy;
    if (legacy.mode) setMode(legacy.mode);
    setSessionsLoading(true);
    setSessionLoading(true);
    setMessages([]);
    setActiveSessionId(null);
    setOpenSnippet(null);

    async function loadSessions() {
      try {
        const list = await api.listChatSessions({
          scope: chatScope,
          recordingId: scopedRecordingId,
        });
        if (cancelled) return;
        setSessions(list);
        if (list[0]) {
          const chat = await api.getChatSession(list[0].id);
          if (cancelled) return;
          setActiveSessionId(chat.id);
          setMessages(uiMessagesFromSession(chat));
          setSessions((prev) => prev.map((session) => (session.id === chat.id ? { ...chat, messages: undefined } : session)));
          persistMode(storageKey, legacy.mode ?? mode);
          return;
        }
        if (legacy.messages.length > 0) {
          const created = await api.createChatSession({
            scope: chatScope,
            title: "Importierter Chat",
            recording_id: scopedRecordingId,
            topic_id: scoped ? null : topicFilter,
          });
          for (const message of legacy.messages.slice(-CHAT_HISTORY_LIMIT)) {
            await api.addChatMessage(created.id, {
              role: message.role,
              content: message.content,
              sources: message.sources ?? null,
            });
          }
          const chat = await api.getChatSession(created.id);
          if (cancelled) return;
          setSessions([{ ...chat, messages: undefined }]);
          setActiveSessionId(chat.id);
          setMessages(uiMessagesFromSession(chat));
          persistMode(storageKey, legacy.mode ?? mode);
        }
      } catch (error) {
        if (!cancelled) setError(String((error as Error).message));
      } finally {
        if (!cancelled) {
          setSessionsLoading(false);
          setSessionLoading(false);
        }
      }
    }

    void loadSessions();
    return () => {
      cancelled = true;
    };
  }, [chatScope, scoped, scopedRecordingId, storageKey]);

  const persistState = useRef<{ key: string; mode: Mode }>({ key: storageKey, mode });
  persistState.current = { key: storageKey, mode };

  const flushPersist = useCallback(() => {
    const { key, mode: currentMode } = persistState.current;
    try {
      const legacy = loadPersistedChat(key);
      localStorage.setItem(
        key,
        JSON.stringify(
          legacy.messages.length > 0
            ? { messages: legacy.messages.slice(-CHAT_HISTORY_LIMIT), mode: currentMode }
            : { mode: currentMode },
        ),
      );
    } catch {
      /* ignore quota / serialization errors */
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(flushPersist, 400);
    return () => clearTimeout(timer);
  }, [mode, storageKey, flushPersist]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      flushPersist();
    },
    [flushPersist],
  );

  const activeFilterCount = (speakerFilter.trim() ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);
  const scopeOpts = scoped
    ? { recordingId: scopedRecordingId, includeTopicContext, speaker: speakerFilter.trim() || null }
    : {
        topicId: topicFilter,
        includeTopicContext: false,
        speaker: speakerFilter.trim() || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      };

  async function createSessionForPrompt(prompt: string): Promise<number> {
    const created = await api.createChatSession({
      scope: chatScope,
      title: shortChatTitle(prompt),
      recording_id: scopedRecordingId,
      topic_id: scoped ? null : topicFilter,
    });
    setSessions((prev) => [{ ...created, messages: undefined }, ...prev]);
    setActiveSessionId(created.id);
    return created.id;
  }

  async function runSearch() {
    const query = input.trim();
    if (!query || searching) return;
    setError(null);
    setSearching(true);
    setHits(null);
    try {
      const response = await api.ragSearch(query, scopeOpts);
      setHits(response.hits);
    } catch (error) {
      setError(String((error as Error).message));
    } finally {
      setSearching(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);
    let sessionId = activeSessionId;
    try {
      if (!sessionId) sessionId = await createSessionForPrompt(text);
    } catch (error) {
      setError(String((error as Error).message));
      return;
    }
    setInput("");
    const history: ChatMessage[] = messages.map((message) => ({ role: message.role, content: message.content }));
    const next: UiMessage[] = [...messages, { role: "user", content: text }, { role: "assistant", content: "" }];
    setMessages(next);
    const assistantIdx = next.length - 1;
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let assistantText = "";
    let assistantSources: RagSource[] = [];
    try {
      await api.ragChat(
        [...history, { role: "user", content: text }],
        { ...scopeOpts, reasoningEffort: reasoningEffort || null },
        {
          signal: controller.signal,
          onSources: (sources) => {
            assistantSources = sources;
            setMessages((prev) => {
              const copy = [...prev];
              copy[assistantIdx] = { ...copy[assistantIdx], sources };
              return copy;
            });
          },
          onDelta: (delta) => {
            assistantText += delta;
            setMessages((prev) => {
              const copy = [...prev];
              copy[assistantIdx] = { ...copy[assistantIdx], content: copy[assistantIdx].content + delta };
              return copy;
            });
          },
        },
      );
      await api.addChatMessage(sessionId, { role: "user", content: text });
      await api.addChatMessage(sessionId, { role: "assistant", content: assistantText, sources: assistantSources });
      const saved = await api.getChatSession(sessionId);
      setSessions((prev) => {
        const rest = prev.filter((session) => session.id !== saved.id);
        return [{ ...saved, messages: undefined }, ...rest].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") setError(String((error as Error).message));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function submit() {
    if (mode === "search") void runSearch();
    else void send();
  }

  function clearChat() {
    abortRef.current?.abort();
    setStreaming(false);
    setOpenSnippet(null);
    setActiveSessionId(null);
    setMessages([]);
  }

  async function deleteActiveChat() {
    if (!activeSessionId || streaming) return;
    const id = activeSessionId;
    try {
      await api.deleteChatSession(id);
      setSessions((prev) => prev.filter((session) => session.id !== id));
      setActiveSessionId(null);
      setOpenSnippet(null);
      setMessages([]);
    } catch (error) {
      setError(String((error as Error).message));
    }
  }

  function resetFilters() {
    setSpeakerFilter("");
    setDateFrom("");
    setDateTo("");
  }

  const ragOff = !!(status && !status.vec_available);
  const searchEmptyPrompts = scoped
    ? ["Welche Entscheidungen wurden getroffen?", "Zeig offene Aufgaben", "Finde Stellen zu Risiken"]
    : ["Welche offenen Punkte gibt es?", "Zeig Entscheidungen der Woche", "Finde Stellen zu Budget"];
  const chatEmptyPrompts = scoped
    ? ["Fasse diese Aufnahme kurz zusammen", "Welche Aufgaben entstanden hier?", "Welche Fragen bleiben offen?"]
    : ["Was waren die wichtigsten Entscheidungen?", "Welche Aufgaben sind offen?", "Was hat sich letzte Woche geändert?"];
  const panelTitle = scoped ? "Fragen zur Aufnahme" : "Wissens-Chat";
  const scopeLabel = scoped
    ? scopedRecordingTitle ?? "Aufnahme"
    : status
      ? `${status.chunks} Passagen · ${status.recordings_indexed} Aufnahmen`
      : "Index wird geladen...";

  return {
    scoped,
    mode,
    setMode,
    chatAvailable,
    sessions,
    activeSessionId,
    sessionsLoading,
    sessionLoading,
    messages,
    input,
    setInput,
    topicFilter,
    setTopicFilter,
    speakerFilter,
    setSpeakerFilter,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    includeTopicContext,
    setIncludeTopicContext,
    reasoningEffort,
    setReasoningEffort,
    showFilters,
    setShowFilters,
    streaming,
    error,
    openSnippet,
    setOpenSnippet,
    hits,
    searching,
    scrollRef,
    activeFilterCount,
    ragOff,
    searchEmptyPrompts,
    chatEmptyPrompts,
    panelTitle,
    scopeLabel,
    resetFilters,
    submit,
    clearChat,
    stopStreaming: () => abortRef.current?.abort(),
    loadChatSession,
    deleteActiveChat,
  };
}

function persistMode(key: string, mode: Mode) {
  try {
    localStorage.setItem(key, JSON.stringify({ mode }));
  } catch {
    /* ignore quota / serialization errors */
  }
}
