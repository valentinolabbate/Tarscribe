import type { Topic } from "../lib/types";
import { ChatComposer } from "./chat-panel/ChatComposer";
import { ChatFilters } from "./chat-panel/ChatFilters";
import { ChatModeView } from "./chat-panel/ChatModeView";
import { ChatToolbar } from "./chat-panel/ChatToolbar";
import { SearchModeView } from "./chat-panel/SearchModeView";
import { useChatPanelController } from "./chat-panel/useChatPanelController";

export function ChatPanel({
  topics = [],
  scopeRecording,
  onOpenSource,
  onOpenDocument,
  embedded = false,
}: {
  topics?: Topic[];
  scopeRecording?: { id: number; title: string };
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
  embedded?: boolean;
}) {
  const chat = useChatPanelController({ scopeRecording });

  return (
    <div className={`chat-panel ${embedded ? "embedded" : ""} ${chat.scoped ? "scoped" : "global"}`}>
      <ChatToolbar
        panelTitle={chat.panelTitle}
        scopeLabel={chat.scopeLabel}
        mode={chat.mode}
        chatAvailable={chat.chatAvailable}
        sessions={chat.sessions}
        activeSessionId={chat.activeSessionId}
        sessionsLoading={chat.sessionsLoading}
        sessionLoading={chat.sessionLoading}
        streaming={chat.streaming}
        searching={chat.searching}
        scoped={chat.scoped}
        includeTopicContext={chat.includeTopicContext}
        showFilters={chat.showFilters}
        activeFilterCount={chat.activeFilterCount}
        topicFilter={chat.topicFilter}
        topics={topics}
        reasoningEffort={chat.reasoningEffort}
        onModeChange={chat.setMode}
        onLoadSession={(id) => {
          if (id == null) chat.clearChat();
          else void chat.loadChatSession(id);
        }}
        onClearChat={chat.clearChat}
        onDeleteActiveChat={() => void chat.deleteActiveChat()}
        onReasoningEffortChange={chat.setReasoningEffort}
        onIncludeTopicContextChange={chat.setIncludeTopicContext}
        onToggleFilters={() => chat.setShowFilters((value) => !value)}
        onTopicFilterChange={chat.setTopicFilter}
      />

      {chat.showFilters && (
        <ChatFilters
          scoped={chat.scoped}
          speakerFilter={chat.speakerFilter}
          dateFrom={chat.dateFrom}
          dateTo={chat.dateTo}
          activeFilterCount={chat.activeFilterCount}
          onSpeakerFilterChange={chat.setSpeakerFilter}
          onDateFromChange={chat.setDateFrom}
          onDateToChange={chat.setDateTo}
          onReset={chat.resetFilters}
        />
      )}

      {chat.ragOff && (
        <div style={{ fontSize: 13, color: "var(--danger)" }}>
          RAG ist nicht verfügbar (sqlite-vec konnte nicht geladen werden). Bitte in den Einstellungen prüfen.
        </div>
      )}

      <div ref={chat.scrollRef} className={`chat-scroll ${chat.mode === "search" ? "search-mode" : "chat-mode"}`}>
        {chat.mode === "search" ? (
          <SearchModeView
            hits={chat.hits}
            searching={chat.searching}
            ragOff={chat.ragOff}
            scoped={chat.scoped}
            topics={topics}
            prompts={chat.searchEmptyPrompts}
            onPrompt={chat.setInput}
            onOpenSource={onOpenSource}
            onOpenDocument={onOpenDocument}
          />
        ) : (
          <ChatModeView
            messages={chat.messages}
            sessionLoading={chat.sessionLoading}
            chatAvailable={chat.chatAvailable}
            ragOff={chat.ragOff}
            scoped={chat.scoped}
            streaming={chat.streaming}
            prompts={chat.chatEmptyPrompts}
            topics={topics}
            scopeRecording={scopeRecording}
            openSnippet={chat.openSnippet}
            onPrompt={chat.setInput}
            onOpenSnippet={chat.setOpenSnippet}
            onOpenSource={onOpenSource}
            onOpenDocument={onOpenDocument}
          />
        )}
      </div>

      {chat.error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{chat.error}</div>}

      <ChatComposer
        input={chat.input}
        mode={chat.mode}
        chatAvailable={chat.chatAvailable}
        ragOff={chat.ragOff}
        searching={chat.searching}
        streaming={chat.streaming}
        sessionLoading={chat.sessionLoading}
        onInputChange={chat.setInput}
        onSubmit={chat.submit}
        onStop={chat.stopStreaming}
      />
    </div>
  );
}
