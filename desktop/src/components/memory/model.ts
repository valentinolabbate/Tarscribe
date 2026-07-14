import type { ActionItem } from "../../lib/types";

export function needsEvidenceReview(
  item: Pick<ActionItem, "kind" | "attention_flags">,
): boolean {
  return item.kind === "task" && item.attention_flags.includes("needs_evidence_review");
}
