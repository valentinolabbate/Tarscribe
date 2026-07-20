import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActionItem } from "../lib/types";
import { TodayItem } from "./StartPage";

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
