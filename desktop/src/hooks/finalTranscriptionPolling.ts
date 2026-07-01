import type { JobEvent } from "../lib/types";

export const FINAL_TRANSCRIPTION_POLL_MS = 1000;
export const FINAL_TRANSCRIPTION_TIMEOUT_MS = 30 * 60 * 1000;

export type FinalTranscriptionPollingFailure = "timeout" | "missing" | "aborted";

export class FinalTranscriptionPollingError extends Error {
  reason: FinalTranscriptionPollingFailure;

  constructor(reason: FinalTranscriptionPollingFailure, message: string) {
    super(message);
    this.name = "FinalTranscriptionPollingError";
    this.reason = reason;
  }
}

interface WaitForFinalTranscriptionOptions {
  recordingId: number;
  jobId: number;
  getJobs: (recordingId: number) => Promise<JobEvent[]>;
  onUpdate: (job: JobEvent) => void;
  onPollError?: (error: unknown) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function isTerminalJob(job: JobEvent): boolean {
  return job.status === "done" || job.status === "failed" || job.status === "canceled";
}

export async function waitForFinalTranscriptionJob({
  recordingId,
  jobId,
  getJobs,
  onUpdate,
  onPollError,
  signal,
  timeoutMs = FINAL_TRANSCRIPTION_TIMEOUT_MS,
  pollMs = FINAL_TRANSCRIPTION_POLL_MS,
  sleep = sleepWithAbort,
  now = () => Date.now(),
}: WaitForFinalTranscriptionOptions): Promise<JobEvent> {
  const startedAt = now();
  for (;;) {
    throwIfAborted(signal);
    if (now() - startedAt >= timeoutMs) {
      throw new FinalTranscriptionPollingError(
        "timeout",
        "Finale Transkription hat das Zeitlimit erreicht.",
      );
    }

    try {
      const jobs = await getJobs(recordingId);
      const job = jobs.find((candidate) => candidate.job_id === jobId);
      if (!job) {
        throw new FinalTranscriptionPollingError(
          "missing",
          "Finaler Transkriptionsjob wurde nicht gefunden.",
        );
      }
      onUpdate(job);
      if (isTerminalJob(job)) return job;
    } catch (error) {
      if (error instanceof FinalTranscriptionPollingError) throw error;
      onPollError?.(error);
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    await sleep(Math.min(pollMs, Math.max(1, remainingMs)), signal);
  }
}

export function failedFinalTranscriptionJob(
  recordingId: number,
  jobId: number,
  error: unknown,
): JobEvent {
  return {
    type: "job",
    job_id: jobId,
    recording_id: recordingId,
    phase: "asr",
    status: "failed",
    progress: 0,
    error: finalTranscriptionErrorMessage(error),
  };
}

export function finalTranscriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Finale Transkription fehlgeschlagen";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FinalTranscriptionPollingError(
      "aborted",
      "Finale Transkription wurde abgebrochen.",
    );
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(
        new FinalTranscriptionPollingError(
          "aborted",
          "Finale Transkription wurde abgebrochen.",
        ),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
