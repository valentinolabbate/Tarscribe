import { describe, expect, it } from "vitest";
import type { ActionItem } from "../../lib/types";
import {
  buildTaskSections,
  filterOwnedItems,
  filterTaskItems,
  getTaskCounts,
} from "./model";

const today = "2026-07-10";

function item(id: number, patch: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    recording_id: 10,
    kind: "task",
    text: `Aufgabe ${id}`,
    assignee: null,
    recipient: null,
    due: null,
    due_date: null,
    source_quote: null,
    source_start_sec: null,
    confidence: 0.5,
    review_state: "confirmed",
    decision_status: "current",
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
    created_at: `2026-07-0${Math.min(id, 9)}T10:00:00Z`,
    updated_at: `2026-07-0${Math.min(id, 9)}T10:00:00Z`,
    recording_title: "Projektmeeting",
    recording_created_at: "2026-07-01T10:00:00Z",
    topic_id: 2,
    topic_name: "Produkt",
    topic_color: "#087f6d",
    ...patch,
  };
}

describe("task view model", () => {
  it("keeps assigned and explicitly adopted entries in the personal view", () => {
    const mine = item(1);
    const adopted = item(2, { is_mine: false, include_in_tasks: true });
    const other = item(3, { is_mine: false });

    expect(filterOwnedItems([mine, adopted, other], "mine").map((entry) => entry.id)).toEqual([
      1, 2,
    ]);
    expect(filterOwnedItems([mine, adopted, other], "all")).toHaveLength(3);
  });

  it("keeps overdue and upcoming seven-day counts separate", () => {
    const entries = [
      item(1, { due_date: "2026-07-09" }),
      item(2, { due_date: "2026-07-10" }),
      item(3, { due_date: "2026-07-17" }),
      item(4, { due_date: "2026-07-18" }),
      item(5, { done: true }),
      item(6, { kind: "decision" }),
    ];

    expect(getTaskCounts(entries, today)).toEqual({
      total: 5,
      open: 4,
      overdue: 1,
      week: 2,
      done: 1,
    });
  });

  it("excludes decisions and searches task source metadata", () => {
    const entries = [
      item(1, { recording_title: "Roadmap-Runde" }),
      item(2, { assignee: "Luna" }),
      item(3, { kind: "decision", text: "Launch im Herbst" }),
    ];

    expect(filterTaskItems(entries, "open", "roadmap", today).map((entry) => entry.id)).toEqual([
      1,
    ]);
    expect(filterTaskItems(entries, "open", "luna", today).map((entry) => entry.id)).toEqual([
      2,
    ]);
    expect(filterTaskItems(entries, "open", "", today).map((entry) => entry.id)).toEqual([2, 1]);
  });

  it("builds the open list in urgency order", () => {
    const entries = filterTaskItems(
      [
        item(1, { due_date: null }),
        item(2, { due_date: "2026-07-20" }),
        item(3, { due_date: "2026-07-12" }),
        item(4, { due_date: "2026-07-08" }),
      ],
      "open",
      "",
      today,
    );
    const sections = buildTaskSections(entries, "open", today);

    expect(sections.map((section) => section.id)).toEqual([
      "overdue",
      "week",
      "later",
      "undated",
    ]);
    expect(sections.flatMap((section) => section.items.map((entry) => entry.id))).toEqual([
      4, 3, 2, 1,
    ]);
  });
});
