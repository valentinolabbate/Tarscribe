import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActionItem } from "../lib/types";

const items = vi.hoisted<ActionItem[]>(() => [
  {
    id: 1,
    recording_id: 7,
    kind: "decision",
    text: "Der Rollout startet im Herbst.",
    assignee: "Ada",
    recipient: null,
    due: null,
    due_date: null,
    source_quote: "Wir starten mit dem Rollout im Herbst.",
    source_start_sec: 84,
    confidence: 0.94,
    review_state: "confirmed",
    decision_status: "current",
    superseded_by_id: null,
    enrichment_state: "complete",
    enriched_at: null,
    evidence_reviewed_at: null,
    attention_flags: [],
    done: false,
    is_mine: false,
    is_involved: true,
    include_in_tasks: false,
    calendar_status: "idle",
    calendar_error: null,
    calendar_exported_at: null,
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
    recording_title: "Produktgespräch",
    recording_created_at: "2026-07-20T09:00:00Z",
    topic_id: 2,
    topic_name: "Produkt",
    topic_color: "#0f766e",
  },
  {
    id: 2,
    recording_id: 7,
    kind: "task",
    text: "Offene Notiz prüfen.",
    assignee: null,
    recipient: null,
    due: null,
    due_date: null,
    source_quote: null,
    source_start_sec: null,
    confidence: 0.6,
    review_state: "pending",
    decision_status: "proposed",
    superseded_by_id: null,
    enrichment_state: "no_match",
    enriched_at: null,
    evidence_reviewed_at: null,
    attention_flags: ["missing_source"],
    done: false,
    is_mine: false,
    is_involved: false,
    include_in_tasks: false,
    calendar_status: "idle",
    calendar_error: null,
    calendar_exported_at: null,
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
    recording_title: "Produktgespräch",
    recording_created_at: "2026-07-20T09:00:00Z",
    topic_id: 2,
    topic_name: "Produkt",
    topic_color: "#0f766e",
  },
]);

vi.mock("../hooks/queries", () => ({
  useDeleteActionItem: () => ({ mutate: vi.fn() }),
  useExtractActionItems: () => ({ isPending: false, mutate: vi.fn() }),
  useRecordingActionItems: () => ({ data: items, isLoading: false, isSuccess: true }),
  useRecordingJobs: () => ({ data: [], isLoading: false }),
  useUpdateActionItem: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../hooks/useJobs", () => ({
  useJobFor: () => undefined,
}));

vi.mock("../hooks/useUndoableDelete", () => ({
  useUndoableDelete: () => ({ isPending: () => false, schedule: vi.fn() }),
}));

import { MeetingTimeline } from "./MeetingTimeline";

describe("MeetingTimeline", () => {
  it("uses the shared evidence trail for timed and missing sources", () => {
    const html = renderToStaticMarkup(
      <MeetingTimeline
        recordingId={7}
        recordingTitle="Produktgespräch"
        topicName="Produkt"
        topicColor="#0f766e"
        currentTime={90}
        playing={false}
        onSeek={vi.fn()}
        onOpenTranscript={vi.fn()}
      />,
    );

    expect(html).toContain("evidence-trail-signal");
    expect(html).toContain("Produktgespräch");
    expect(html).toContain("Wir starten mit dem Rollout im Herbst.");
    expect(html).toContain("1:24");
    expect(html).toContain("Belegspur fehlt");
  });
});
