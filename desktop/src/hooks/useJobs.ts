import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { JobEvent, LiveEvent } from "../lib/types";

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

// Agent research events: recording_id -> list of tool-call events.
export interface AgentResearchState {
  queries: { query: string; scope: string; hits: number; round: number }[];
  done: boolean;
  sources: number;
  task?: string;
}
let agentResearch = new Map<number, AgentResearchState>();

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
function agentResearchSnapshot() {
  return agentResearch;
}

export function useJobFor(recordingId: number): JobEvent | undefined {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot);
  return map.get(recordingId);
}

export function useSummaryStream(summaryId: number | null): SummaryStream | undefined {
  const map = useSyncExternalStore(subscribe, summariesSnapshot, summariesSnapshot);
  return summaryId != null ? map.get(summaryId) : undefined;
}

export function useAgentResearch(recordingId: number | null): AgentResearchState | undefined {
  const map = useSyncExternalStore(subscribe, agentResearchSnapshot, agentResearchSnapshot);
  return recordingId != null ? map.get(recordingId) : undefined;
}

export function clearAgentResearch(recordingId: number) {
  if (!agentResearch.has(recordingId)) return;
  agentResearch = new Map(agentResearch);
  agentResearch.delete(recordingId);
  emit();
}

export function preferJobEvent(
  live: JobEvent | undefined,
  polled: JobEvent | null | undefined,
): JobEvent | undefined {
  if (!live) return polled ?? undefined;
  if (!polled) return live;
  if (live.job_id !== polled.job_id) return live.job_id > polled.job_id ? live : polled;
  const terminal = (job: JobEvent) => job.status === "done" || job.status === "failed" || job.status === "canceled";
  if (terminal(polled) && !terminal(live)) return polled;
  if (terminal(live) && !terminal(polled)) return live;
  return polled.progress > live.progress ? polled : live;
}

export function clearJobFor(recordingId: number) {
  if (!jobs.has(recordingId)) return;
  jobs = new Map(jobs);
  jobs.delete(recordingId);
  emit();
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

/** Mount once (in App) to stream job + live events and refresh data on completion. */
export function useJobSocket(onLive?: (e: LiveEvent) => void) {
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
              if (e.phase === "action_items") qc.invalidateQueries({ queryKey: ["action-items"] });
              if (e.phase === "chapters") qc.invalidateQueries({ queryKey: ["chapters", e.recording_id] });
              if (e.phase === "diarization") qc.invalidateQueries({ queryKey: ["speaker-stats", e.recording_id] });
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
          onLive,
          (e) => {
            if (e.recording_id == null) return;
            const prev = agentResearch.get(e.recording_id) ?? { queries: [], done: false, sources: 0, task: e.task };
            if (e.phase === "tool_call") {
              agentResearch = new Map(agentResearch).set(e.recording_id, {
                ...prev,
                queries: [...prev.queries, { query: e.query || "", scope: e.scope || "topic", hits: 0, round: e.round }],
                done: false,
                task: e.task ?? prev.task,
              });
            } else if (e.phase === "tool_result") {
              const queries = [...prev.queries];
              if (queries.length > 0) {
                const last = queries[queries.length - 1];
                queries[queries.length - 1] = { ...last, hits: e.hits ?? 0 };
              }
              agentResearch = new Map(agentResearch).set(e.recording_id, {
                ...prev,
                queries,
                done: false,
              });
            } else if (e.phase === "done") {
              agentResearch = new Map(agentResearch).set(e.recording_id, {
                ...prev,
                done: true,
                sources: e.sources ?? 0,
              });
            }
            emit();
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
  }, [qc, onLive]);
}
