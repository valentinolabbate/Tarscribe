import { describe, expect, it } from "vitest";
import type { ActionItem, Utterance } from "../../lib/types";
import { activeTimelineItemId, sortTimelineItems, speakerAt, timelineKind } from "./model";

function item(id: number, start: number | null, kind: ActionItem["kind"] = "task"): ActionItem {
  return {
    id,
    recording_id: 1,
    kind,
    text: `Eintrag ${id}`,
    assignee: null,
    recipient: null,
    due: null,
    due_date: null,
    source_quote: null,
    source_start_sec: start,
    confidence: 0.9,
    review_state: "confirmed",
    decision_status: "current",
    superseded_by_id: null,
    enrichment_state: "complete",
    enriched_at: null,
    evidence_reviewed_at: null,
    attention_flags: [],
    done: false,
    is_mine: false,
    is_involved: false,
    include_in_tasks: false,
    calendar_status: "idle",
    calendar_error: null,
    calendar_exported_at: null,
    created_at: "2026-07-14T10:00:00Z",
    updated_at: "2026-07-14T10:00:00Z",
    recording_title: "Meeting",
    recording_created_at: "2026-07-14T10:00:00Z",
    topic_id: 1,
    topic_name: "Produkt",
    topic_color: "#087f6d",
  };
}

describe("meeting timeline model", () => {
  it("classifies decisions, explicit commitments and tasks", () => {
    expect(timelineKind(item(1, 2, "decision"))).toBe("decision");
    expect(timelineKind({ ...item(2, 3), recipient: "Team" })).toBe("commitment");
    expect(timelineKind(item(3, 4))).toBe("task");
  });

  it("orders timed entries before entries without a source position", () => {
    expect(sortTimelineItems([item(1, null), item(2, 18), item(3, 4)]).map((entry) => entry.id)).toEqual([
      3,
      2,
      1,
    ]);
    expect(activeTimelineItemId([item(1, 10), item(2, 25)], 20)).toBe(1);
  });

  it("resolves the speaker from the source timestamp", () => {
    const utterances: Utterance[] = [
      { speaker: "SPEAKER_00", name: "Mira", start: 4, end: 9, text: "Hallo" },
      { speaker: "SPEAKER_01", name: "Anna", start: 9, end: 14, text: "Weiter" },
    ];
    expect(speakerAt(utterances, 6)).toBe("Mira");
    expect(speakerAt(utterances, 9)).toBe("Anna");
    expect(speakerAt(utterances, 15.5)).toBe("Anna");
    expect(speakerAt(utterances, 20)).toBeNull();
  });
});
