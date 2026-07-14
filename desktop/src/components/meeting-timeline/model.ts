import type { ActionItem, Utterance } from "../../lib/types";

export type TimelineKind = "decision" | "commitment" | "task";

export function timelineKind(item: Pick<ActionItem, "kind" | "recipient">): TimelineKind {
  if (item.kind === "decision") return "decision";
  return item.recipient ? "commitment" : "task";
}

export function sortTimelineItems(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => {
    if (a.source_start_sec == null) return b.source_start_sec == null ? a.id - b.id : 1;
    if (b.source_start_sec == null) return -1;
    return a.source_start_sec - b.source_start_sec || a.id - b.id;
  });
}

export function speakerAt(utterances: Utterance[], startSec: number | null): string | null {
  if (startSec == null) return null;
  const exact = utterances.find(
    (utterance) => startSec >= utterance.start && startSec < utterance.end,
  );
  if (exact) return exact.name || exact.speaker;
  const nearest = utterances
    .map((utterance) => ({
      utterance,
      distance: Math.min(Math.abs(startSec - utterance.start), Math.abs(startSec - utterance.end)),
    }))
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance <= 2
    ? nearest.utterance.name || nearest.utterance.speaker
    : null;
}

export function activeTimelineItemId(items: ActionItem[], currentTime: number): number | null {
  let active: ActionItem | null = null;
  for (const item of sortTimelineItems(items)) {
    if (item.source_start_sec == null || item.source_start_sec > currentTime) break;
    active = item;
  }
  return active?.id ?? null;
}
