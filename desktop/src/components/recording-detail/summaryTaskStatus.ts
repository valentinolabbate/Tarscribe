import type { JobEvent } from "../../lib/types";

export type SummaryTaskState =
  | "loading"
  | "extracting"
  | "extracted"
  | "empty"
  | "failed"
  | "missing";

export function summaryTaskState({
  itemCount,
  job,
  extractionPending,
  loading,
}: {
  itemCount: number;
  job?: JobEvent | null;
  extractionPending: boolean;
  loading: boolean;
}): SummaryTaskState {
  if (
    extractionPending ||
    (job?.phase === "action_items" &&
      (job.status === "pending" || job.status === "running"))
  ) {
    return "extracting";
  }
  if (itemCount > 0) return "extracted";
  if (job?.phase === "action_items" && job.status === "done") return "empty";
  if (
    job?.phase === "action_items" &&
    (job.status === "failed" || job.status === "canceled")
  ) {
    return "failed";
  }
  return loading ? "loading" : "missing";
}
