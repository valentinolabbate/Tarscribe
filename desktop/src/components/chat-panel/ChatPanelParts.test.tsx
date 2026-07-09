import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RagHit, RagSource, Topic } from "../../lib/types";
import { ChatComposer } from "./ChatComposer";
import { ChatModeView } from "./ChatModeView";
import { ChatToolbar } from "./ChatToolbar";
import { SearchModeView } from "./SearchModeView";
import { buildContextChips, updateChatResearchToolCalls } from "./model";

const topic: Topic = {
  id: 7,
  name: "Produkt",
  color: "#0f766e",
  export_path: null,
  calendar_export_mode: "off",
  calendar_url: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  recording_count: 1,
  transcribed_count: 1,
  diarized_count: 1,
  exported_count: 0,
};

const source: RagSource = {
  index: 1,
  recording_id: 3,
  recording_title: "Standup",
  topic_id: topic.id,
  source_type: "transcript",
  start_sec: 12,
  end_sec: 18,
  speaker: "Valentino",
  text: "Wir entscheiden uns für den sicheren Weg.",
};

const hit: RagHit = {
  chunk_id: 42,
  recording_id: 3,
  recording_title: "Standup",
  topic_id: topic.id,
  source_type: "transcript",
  text: "Budget und Risiko wurden besprochen.",
  start_sec: 12,
  end_sec: 18,
  speaker: "Valentino",
};

function text(markup: string) {
  return markup.replace(/\s+/g, " ");
}

describe("chat panel parts", () => {
  it("summarizes answer context chips", () => {
    expect(buildContextChips([source], [topic], { id: 3, title: "Standup" })).toEqual([
      { label: "Aufnahme Standup", title: "Aufnahme: Standup" },
      { label: "1 Transkriptstelle" },
      { label: "Thema Produkt", title: "Themenbereich: Produkt" },
    ]);
  });

  it("updates chat research tool calls from streamed events", () => {
    const started = updateChatResearchToolCalls([], {
      type: "agent_research",
      phase: "tool_call",
      round: 0,
      tool: "search_knowledge",
      query: "Budget Risiken",
      scope: "all",
    });
    expect(started).toEqual([
      {
        round: 0,
        tool: "search_knowledge",
        query: "Budget Risiken",
        scope: "all",
        hits: null,
      },
    ]);

    expect(
      updateChatResearchToolCalls(started, {
        type: "agent_research",
        phase: "tool_result",
        round: 0,
        tool: "search_knowledge",
        hits: 3,
      }),
    ).toEqual([{ ...started[0], hits: 3 }]);
  });

  it("renders toolbar controls in isolation", () => {
    const html = renderToStaticMarkup(
      <ChatToolbar
        panelTitle="Wissens-Chat"
        scopeLabel="1 Passage"
        mode="chat"
        chatAvailable
        sessions={[]}
        activeSessionId={null}
        sessionsLoading={false}
        sessionLoading={false}
        streaming={false}
        searching={false}
        scoped={false}
        includeTopicContext={false}
        showFilters={false}
        activeFilterCount={0}
        topicFilter={null}
        topics={[topic]}
        reasoningEffort=""
        onModeChange={vi.fn()}
        onLoadSession={vi.fn()}
        onClearChat={vi.fn()}
        onDeleteActiveChat={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onIncludeTopicContextChange={vi.fn()}
        onToggleFilters={vi.fn()}
        onTopicFilterChange={vi.fn()}
      />,
    );

    expect(text(html)).toContain("Wissens-Chat");
    expect(text(html)).toContain("Produkt");
  });

  it("renders search results in isolation", () => {
    const html = renderToStaticMarkup(
      <SearchModeView
        hits={[hit]}
        searching={false}
        ragOff={false}
        scoped={false}
        prompts={["Risiken?"]}
        onPrompt={vi.fn()}
        onOpenSource={vi.fn()}
      />,
    );

    expect(text(html)).toContain("Budget und Risiko");
    expect(text(html)).toContain("Aufnahme öffnen");
  });

  it("renders chat messages and composer in isolation", () => {
    const messageHtml = renderToStaticMarkup(
      <ChatModeView
        messages={[
          {
            role: "assistant",
            content: "Antwort mit Quelle [1].",
            sources: [source],
            agent_research: [
              { round: 0, tool: "search_knowledge", query: "alte Suche 1", scope: "all", hits: 1 },
              { round: 1, tool: "search_knowledge", query: "alte Suche 2", scope: "all", hits: 2 },
              { round: 2, tool: "search_knowledge", query: "neue Suche 1", scope: "topic", hits: 3 },
              { round: 3, tool: "search_knowledge", query: "neue Suche 2", scope: "topic", hits: 4 },
              { round: 4, tool: "search_knowledge", query: "neue Suche 3", scope: "recording", hits: null },
            ],
          },
        ]}
        sessionLoading={false}
        chatAvailable
        ragOff={false}
        scoped={false}
        streaming={false}
        prompts={[]}
        topics={[topic]}
        openSnippet={{ m: 0, s: 1 }}
        onPrompt={vi.fn()}
        onOpenSnippet={vi.fn()}
        onOpenSource={vi.fn()}
      />,
    );
    const composerHtml = renderToStaticMarkup(
      <ChatComposer
        input="Hallo"
        mode="chat"
        chatAvailable
        ragOff={false}
        searching={false}
        streaming={false}
        sessionLoading={false}
        onInputChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(text(messageHtml)).toContain("Diese Antwort nutzt");
    expect(text(messageHtml)).toContain("RAG-Recherche");
    expect(text(messageHtml)).toContain("Erweitern (2)");
    expect(text(messageHtml)).not.toContain("alte Suche 1");
    expect(text(messageHtml)).toContain("neue Suche 3");
    expect(text(messageHtml)).toContain("Wir entscheiden uns");
    expect(text(composerHtml)).toContain("Senden");
  });
});
