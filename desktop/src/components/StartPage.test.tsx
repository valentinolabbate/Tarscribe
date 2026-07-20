import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActionItem, TopicThread } from "../lib/types";
import { ThreadList, TodayItem } from "./StartPage";

const baseItem: ActionItem = {
  id: 7,
  recording_id: 3,
  kind: "task",
  text: "Angebot vorbereiten",
  assignee: "Valentino",
  recipient: null,
  due: null,
  due_date: null,
  source_quote: "Ich bereite das Angebot vor.",
  source_start_sec: 42,
  confidence: 0.92,
  review_state: "confirmed",
  decision_status: "proposed",
  superseded_by_id: null,
  enrichment_state: "complete",
  enriched_at: null,
  evidence_reviewed_at: null,
  attention_flags: [],
  done: false,
  is_mine: true,
  is_involved: true,
  include_in_tasks: false,
  calendar_status: "idle",
  calendar_error: null,
  calendar_exported_at: null,
  created_at: "2026-07-20T08:00:00Z",
  updated_at: "2026-07-20T08:00:00Z",
  recording_title: "Projektstatus",
  recording_created_at: "2026-07-20T08:00:00Z",
  topic_id: 2,
  topic_name: "Tarscribe",
  topic_color: "#087f6d",
};

function renderItem(item: ActionItem) {
  return renderToStaticMarkup(
    <TodayItem
      item={item}
      onOpenSource={vi.fn()}
      onOpenMemoryItem={vi.fn()}
      onComplete={vi.fn()}
      completing={false}
    />,
  );
}

describe("TodayItem", () => {
  it("offers completion and the tasks subpage for a normal task", () => {
    const html = renderItem(baseItem);

    expect(html).toContain("Aufgabe");
    expect(html).toContain("Erledigen");
    expect(html).toContain("Aufgaben öffnen");
    expect(html).toContain("Aufgabe als erledigt markieren");
  });

  it("labels a recipient-bound task as a commitment and opens the radar", () => {
    const html = renderItem({ ...baseItem, recipient: "Ada Lovelace" });

    expect(html).toContain("Zusage");
    expect(html).toContain("Fertig");
    expect(html).toContain("Radar öffnen");
    expect(html).toContain("Zusage als fertig markieren");
  });
});

function makeThread(id: number, mentionCount = 1): TopicThread {
  return {
    id,
    title: `Thread ${id}`,
    updated_at: "2026-07-20T08:00:00Z",
    created_at: "2026-07-20T08:00:00Z",
    mention_count: mentionCount,
    recording_count: mentionCount,
    mentions: Array.from({ length: mentionCount }, (_, index) => ({
      id: id * 100 + index,
      thread_id: id,
      recording_id: id * 100 + index,
      recording_title: `Quelle ${id}-${index + 1}`,
      topic_id: 2,
      topic_name: "Tarscribe",
      topic_color: "#087f6d",
      start_sec: index * 60,
      text: `Fundstelle ${index + 1}`,
      created_at: "2026-07-20T08:00:00Z",
      recording_created_at: `2026-07-${String(index + 1).padStart(2, "0")}T08:00:00Z`,
    })),
  };
}

describe("ThreadList", () => {
  it("shows every expanded thread instead of limiting the result to five", () => {
    const html = renderToStaticMarkup(
      <ThreadList
        threads={Array.from({ length: 8 }, (_, index) => makeThread(index + 1))}
        onOpenSource={vi.fn()}
      />,
    );

    expect(html).toContain("Thread 1");
    expect(html).toContain("Thread 8");
    expect((html.match(/class="thread-card"/g) ?? []).length).toBe(8);
  });

  it("shows every source found inside a thread", () => {
    const html = renderToStaticMarkup(
      <ThreadList threads={[makeThread(1, 8)]} onOpenSource={vi.fn()} />,
    );

    expect(html).toContain('title="Quelle 1-8"');
    expect((html.match(/class="thread-chip"/g) ?? []).length).toBe(8);
  });
});
