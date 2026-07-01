import { describe, expect, it, vi } from "vitest";
import type { JobEvent } from "../lib/types";
import {
  waitForFinalTranscriptionJob,
} from "./finalTranscriptionPolling";

function job(
  status: JobEvent["status"],
  overrides: Partial<JobEvent> = {},
): JobEvent {
  return {
    type: "job",
    job_id: 7,
    recording_id: 3,
    phase: "asr",
    status,
    progress: status === "done" ? 1 : 0.2,
    error: null,
    ...overrides,
  };
}

describe("waitForFinalTranscriptionJob", () => {
  it("resolves when the final transcription job reaches a terminal state", async () => {
    const onUpdate = vi.fn();
    const getJobs = vi
      .fn()
      .mockResolvedValueOnce([job("running")])
      .mockResolvedValueOnce([job("done")]);

    const result = await waitForFinalTranscriptionJob({
      recordingId: 3,
      jobId: 7,
      getJobs,
      onUpdate,
      pollMs: 10,
      sleep: async () => undefined,
    });

    expect(result.status).toBe("done");
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when the referenced job is missing", async () => {
    await expect(
      waitForFinalTranscriptionJob({
        recordingId: 3,
        jobId: 7,
        getJobs: async () => [job("running", { job_id: 8 })],
        onUpdate: vi.fn(),
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      reason: "missing",
    });
  });

  it("fails after the configured timeout", async () => {
    let now = 0;

    await expect(
      waitForFinalTranscriptionJob({
        recordingId: 3,
        jobId: 7,
        getJobs: async () => [job("running")],
        onUpdate: vi.fn(),
        timeoutMs: 2500,
        pollMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("stops polling when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const getJobs = vi.fn();

    await expect(
      waitForFinalTranscriptionJob({
        recordingId: 3,
        jobId: 7,
        getJobs,
        onUpdate: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      reason: "aborted",
    });
    expect(getJobs).not.toHaveBeenCalled();
  });
});
