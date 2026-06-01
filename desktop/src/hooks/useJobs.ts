import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { JobEvent } from "../lib/types";

// Tiny external store: recording_id -> latest job event.
let jobs = new Map<number, JobEvent>();
const listeners = new Set<() => void>();

// Streaming summary text: summary_id -> { text, done, error }.
export interface SummaryStream {
  text: string;
  done: boolean;
  error?: string;
}
let summaries = new Map<number, SummaryStream>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function snapshot() {
  return jobs;
}
function summariesSnapshot() {
  return summaries;
}

export function useJobFor(recordingId: number): JobEvent | undefined {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot);
  return map.get(recordingId);
}

export function useSummaryStream(summaryId: number | null): SummaryStream | undefined {
  const map = useSyncExternalStore(subscribe, summariesSnapshot, summariesSnapshot);
  return summaryId != null ? map.get(summaryId) : undefined;
}

export function trackPendingJob(recordingId: number, jobId: number, phase: string) {
  if (jobs.get(recordingId)?.job_id === jobId) return;
  jobs = new Map(jobs).set(recordingId, {
    type: "job",
    job_id: jobId,
    recording_id: recordingId,
    phase,
    status: "pending",
    progress: 0,
    error: null,
  });
  emit();
}

export function trackSummaryStart(summaryId: number) {
  if (summaries.has(summaryId)) return;
  summaries = new Map(summaries).set(summaryId, { text: "", done: false });
  emit();
}

/** Mount once (in App) to stream job events and refresh data on completion. */
export function useJobSocket() {
  const qc = useQueryClient();
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let closed = false;
    api
      .connectJobs(
        (e) => {
          jobs = new Map(jobs).set(e.recording_id, e);
          emit();
          if (e.status === "done" || e.status === "failed") {
            qc.invalidateQueries({ queryKey: ["recordings"] });
            qc.invalidateQueries({ queryKey: ["transcript", e.recording_id] });
            qc.invalidateQueries({ queryKey: ["diarization", e.recording_id] });
          }
        },
        (e) => {
          const prev = summaries.get(e.summary_id) ?? { text: "", done: false };
          summaries = new Map(summaries).set(e.summary_id, {
            text: prev.text + (e.delta || ""),
            done: e.done,
            error: e.error,
          });
          emit();
          if (e.done) qc.invalidateQueries({ queryKey: ["summaries", e.recording_id] });
        },
      )
      .then((c) => {
        if (closed) c();
        else cleanup = c;
      });
    return () => {
      closed = true;
      cleanup?.();
    };
  }, [qc]);
}
