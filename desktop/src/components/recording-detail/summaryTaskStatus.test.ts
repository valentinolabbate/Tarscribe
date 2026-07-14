import { describe, expect, it } from "vitest";
import type { JobEvent } from "../../lib/types";
import { summaryTaskState } from "./summaryTaskStatus";

function job(status: JobEvent["status"], phase = "action_items"): JobEvent {
  return {
    job_id: 1,
    recording_id: 1,
    phase,
    status,
    progress: status === "done" ? 1 : 0.5,
    error: status === "failed" ? "Analyse fehlgeschlagen" : null,
  };
}

describe("summary task extraction status", () => {
  it("distinguishes missing extraction from a completed empty result", () => {
    expect(
      summaryTaskState({ itemCount: 0, job: null, extractionPending: false, loading: false }),
    ).toBe("missing");
    expect(
      summaryTaskState({ itemCount: 0, job: job("done"), extractionPending: false, loading: false }),
    ).toBe("empty");
  });

  it("keeps existing extracted tasks visible when a later run failed", () => {
    expect(
      summaryTaskState({ itemCount: 3, job: job("failed"), extractionPending: false, loading: false }),
    ).toBe("extracted");
  });

  it("prioritizes an active extraction", () => {
    expect(
      summaryTaskState({ itemCount: 3, job: job("running"), extractionPending: false, loading: false }),
    ).toBe("extracting");
    expect(
      summaryTaskState({ itemCount: 0, job: null, extractionPending: true, loading: false }),
    ).toBe("extracting");
  });

  it("reports failed and loading states", () => {
    expect(
      summaryTaskState({ itemCount: 0, job: job("failed"), extractionPending: false, loading: false }),
    ).toBe("failed");
    expect(
      summaryTaskState({ itemCount: 0, job: undefined, extractionPending: false, loading: true }),
    ).toBe("loading");
  });
});
