import { fmtDuration } from "../../lib/format";
import type {
  AgentResearchEvent,
  ChatMessage,
  ChatResearchToolCall,
  ChatSession,
  RagHit,
  RagSource,
  Topic,
} from "../../lib/types";

export interface UiMessage extends ChatMessage {
  sources?: RagSource[];
  agent_research?: ChatResearchToolCall[];
}

export type Mode = "search" | "chat";
export type ReasoningEffort = "" | "minimal" | "low" | "medium" | "high";

export const CHAT_HISTORY_LIMIT = 50;

export interface PersistedChat {
  messages: UiMessage[];
  mode: Mode | null;
}

export interface ContextChip {
  label: string;
  title?: string;
}

export function chatStorageKey(scope?: { id: number }): string {
  return scope ? `ts-chat-rec-${scope.id}` : "ts-chat-global";
}

export function loadPersistedChat(key: string): PersistedChat {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { messages: [], mode: null };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { messages: parsed as UiMessage[], mode: null };
    return {
      messages: Array.isArray(parsed.messages) ? (parsed.messages as UiMessage[]) : [],
      mode: parsed.mode === "search" || parsed.mode === "chat" ? parsed.mode : null,
    };
  } catch {
    return { messages: [], mode: null };
  }
}

export function uiMessagesFromSession(chat: ChatSession): UiMessage[] {
  return (chat.messages ?? []).map((message) => ({
    role: message.role,
    content: message.content,
    sources: message.sources ?? undefined,
    agent_research: message.agent_research ?? undefined,
  }));
}

export function updateChatResearchToolCalls(
  current: ChatResearchToolCall[],
  event: AgentResearchEvent,
): ChatResearchToolCall[] {
  if (event.phase === "tool_call") {
    return [
      ...current,
      {
        round: event.round,
        tool: event.tool || "search_knowledge",
        query: event.query || "",
        scope: event.scope || "topic",
        hits: null,
      },
    ];
  }
  if (event.phase === "tool_result") {
    const index = current
      .map((call, idx) => ({ call, idx }))
      .reverse()
      .find(({ call }) => call.round === event.round && call.hits == null)?.idx;
    if (index == null) return current;
    return current.map((call, idx) => (idx === index ? { ...call, hits: event.hits ?? 0 } : call));
  }
  return current;
}

export function shortChatTitle(text: string): string {
  const title = text.trim().replace(/\s+/g, " ");
  return title.length > 60 ? `${title.slice(0, 57)}...` : title || "Neuer Chat";
}

export function sourceTypeLabel(type: RagSource["source_type"]): string {
  if (type === "summary") return "Zusammenfassung";
  if (type === "document") return "Dokument";
  return "Transkript";
}

export function sourceMeta(source: RagSource | RagHit, withTitle: boolean): string {
  const parts: string[] = [];
  if (withTitle) parts.push(source.recording_title);
  parts.push(sourceTypeLabel(source.source_type));
  if (source.speaker) parts.push(source.speaker);
  if (source.start_sec != null) {
    parts.push(
      `${fmtDuration(source.start_sec)}${source.end_sec != null ? `–${fmtDuration(source.end_sec)}` : ""}`,
    );
  }
  return parts.join(" · ");
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

export function buildContextChips(
  sources: RagSource[],
  topics: Topic[],
  scopeRecording?: { id: number; title: string },
): ContextChip[] {
  const chips: ContextChip[] = [];
  const recordingIds = Array.from(
    new Set(sources.map((source) => source.recording_id).filter((id): id is number => id != null)),
  );

  if (recordingIds.length === 1) {
    const title =
      scopeRecording?.id === recordingIds[0]
        ? scopeRecording.title
        : sources.find((source) => source.recording_id === recordingIds[0] && source.source_type !== "document")
            ?.recording_title;
    chips.push({
      label: title ? `Aufnahme ${title}` : "1 Aufnahme",
      title: title ? `Aufnahme: ${title}` : undefined,
    });
  } else if (recordingIds.length > 1) {
    chips.push({ label: `${recordingIds.length} Aufnahmen` });
  }

  const transcripts = sources.filter((source) => source.source_type === "transcript").length;
  const summaries = sources.filter((source) => source.source_type === "summary").length;
  const documents = sources.filter((source) => source.source_type === "document").length;
  if (transcripts) chips.push({ label: countLabel(transcripts, "Transkriptstelle", "Transkriptstellen") });
  if (summaries) chips.push({ label: countLabel(summaries, "Zusammenfassungsstelle", "Zusammenfassungsstellen") });
  if (documents) chips.push({ label: countLabel(documents, "Dokumentstelle", "Dokumentstellen") });

  const topicNamesById = new Map(topics.map((topic) => [topic.id, topic.name]));
  const topicIds = Array.from(
    new Set(sources.map((source) => source.topic_id).filter((id): id is number => id != null)),
  );
  const topicNames = topicIds.map((id) => topicNamesById.get(id)).filter((name): name is string => !!name);
  if (topicNames.length === 1) {
    chips.push({ label: `Thema ${topicNames[0]}`, title: `Themenbereich: ${topicNames[0]}` });
  } else if (topicNames.length === 2) {
    chips.push({ label: `Themen ${topicNames.join(", ")}` });
  } else if (topicNames.length > 2) {
    chips.push({ label: `${topicNames.length} Themenbereiche` });
  } else if (topicIds.length > 0) {
    chips.push({ label: countLabel(topicIds.length, "Themenbereich", "Themenbereiche") });
  }

  return chips;
}
