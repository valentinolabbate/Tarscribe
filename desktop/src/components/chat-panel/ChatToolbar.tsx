import type { ChatSession, Topic } from "../../lib/types";
import { ChatIcon } from "../icons";
import type { Mode, ReasoningEffort } from "./model";

export function ChatToolbar({
  panelTitle,
  scopeLabel,
  mode,
  chatAvailable,
  sessions,
  activeSessionId,
  sessionsLoading,
  sessionLoading,
  streaming,
  searching,
  scoped,
  includeTopicContext,
  showFilters,
  activeFilterCount,
  topicFilter,
  topics,
  reasoningEffort,
  onModeChange,
  onLoadSession,
  onClearChat,
  onDeleteActiveChat,
  onReasoningEffortChange,
  onIncludeTopicContextChange,
  onToggleFilters,
  onTopicFilterChange,
}: {
  panelTitle: string;
  scopeLabel: string;
  mode: Mode;
  chatAvailable: boolean;
  sessions: ChatSession[];
  activeSessionId: number | null;
  sessionsLoading: boolean;
  sessionLoading: boolean;
  streaming: boolean;
  searching: boolean;
  scoped: boolean;
  includeTopicContext: boolean;
  showFilters: boolean;
  activeFilterCount: number;
  topicFilter: number | null;
  topics: Topic[];
  reasoningEffort: ReasoningEffort;
  onModeChange: (mode: Mode) => void;
  onLoadSession: (id: number | null) => void;
  onClearChat: () => void;
  onDeleteActiveChat: () => void;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  onIncludeTopicContextChange: (value: boolean) => void;
  onToggleFilters: () => void;
  onTopicFilterChange: (value: number | null) => void;
}) {
  return (
    <div className="chat-panel-toolbar">
      <div className="chat-panel-title">
        <ChatIcon width={18} height={18} />
        <div>
          <strong>{mode === "search" ? (scoped ? "Aufnahme durchsuchen" : "Archivsuche") : panelTitle}</strong>
          {scopeLabel && <span>{scopeLabel}</span>}
        </div>
      </div>
      <div className="seg chat-mode-toggle">
        <button className={mode === "search" ? "seg-btn active" : "seg-btn"} onClick={() => onModeChange("search")}>
          Suche
        </button>
        <button
          className={`${mode === "chat" ? "seg-btn active" : "seg-btn"} ${!chatAvailable ? "unavailable" : ""}`}
          onClick={() => onModeChange("chat")}
          title={chatAvailable ? "" : "Kein Chat-Modell konfiguriert (Einstellungen → Zusammenfassung)"}
        >
          Chat
        </button>
      </div>
      {mode === "chat" && (
        <select
          className="chat-session-select"
          aria-label="Gespeicherten Chat auswählen"
          value={activeSessionId ?? ""}
          disabled={sessionsLoading || sessionLoading || streaming}
          onChange={(event) => onLoadSession(event.target.value ? Number(event.target.value) : null)}
          title="Gespeicherten Chat auswählen"
        >
          <option value="">{sessionsLoading ? "Chats werden geladen..." : "Neuer Chat"}</option>
          {sessions.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title || "Neuer Chat"}
              {chat.message_count > 0 ? ` (${chat.message_count})` : ""}
            </option>
          ))}
        </select>
      )}
      <div className="chat-toolbar-spacer" />
      {mode === "chat" && (
        <select
          className="chat-thinking-select"
          aria-label="Thinking-Level"
          title="Denk-/Reasoning-Tiefe für diese Chat-Antwort. Standard nutzt das Chat-Profil."
          value={reasoningEffort}
          disabled={streaming}
          onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}
        >
          <option value="">Thinking: Standard</option>
          <option value="minimal">Thinking: Minimal</option>
          <option value="low">Thinking: Niedrig</option>
          <option value="medium">Thinking: Mittel</option>
          <option value="high">Thinking: Hoch</option>
        </select>
      )}
      {scoped && (
        <label
          className={includeTopicContext ? "chat-topic-context-toggle active" : "chat-topic-context-toggle"}
          title="Sucht zusätzlich in anderen Quellen desselben Themenbereichs."
        >
          <input
            type="checkbox"
            checked={includeTopicContext}
            onChange={(event) => onIncludeTopicContextChange(event.target.checked)}
            disabled={streaming || searching}
          />
          Themenbereich
        </label>
      )}
      {mode === "chat" && (
        <button
          className="btn ghost"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onClearChat}
          disabled={streaming}
          title="Einen neuen Chat in diesem Bereich starten"
        >
          Neuer Chat
        </button>
      )}
      {mode === "chat" && activeSessionId && (
        <button
          className="btn ghost danger"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onDeleteActiveChat}
          disabled={streaming}
          title="Diesen gespeicherten Chat löschen"
        >
          Löschen
        </button>
      )}
      <button
        className={showFilters || activeFilterCount > 0 ? "btn ghost active" : "btn ghost"}
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={onToggleFilters}
      >
        Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
      </button>
      {!scoped && (
        <select
          aria-label="Themenbereich"
          value={topicFilter ?? ""}
          onChange={(event) => onTopicFilterChange(event.target.value ? Number(event.target.value) : null)}
          style={{ maxWidth: 172 }}
        >
          <option value="">Alle Themenbereiche</option>
          {topics.map((topic) => (
            <option key={topic.id} value={topic.id}>
              {topic.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
