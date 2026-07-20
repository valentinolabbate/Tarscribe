import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DiarizeParams } from "../lib/api";
import type { ActionItem, DocumentSourceKind, Topic } from "../lib/types";
import { trackPendingJob } from "./useJobs";

export function useHardware() {
  return useQuery({ queryKey: ["hardware"], queryFn: api.hardware, staleTime: Infinity });
}

export function useTopics() {
  return useQuery({ queryKey: ["topics"], queryFn: api.listTopics });
}

export function useCreateTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color?: string }) =>
      api.createTopic(name, color),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topics"] }),
  });
}

export function useUpdateTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: number;
      patch: {
        name?: string;
        color?: string;
        export_path?: string;
        calendar_export_mode?: Topic["calendar_export_mode"];
        calendar_url?: string | null;
      };
    }) => api.updateTopic(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topics"] }),
  });
}

export function useDeleteTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteTopic(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topics"] }),
  });
}

export function useReorderTopics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (order: number[]) => api.reorderTopics(order),
    // Optimistically reorder the cached list so the sidebar stays put even if
    // a background refetch lands before the request resolves.
    onMutate: async (order: number[]) => {
      await qc.cancelQueries({ queryKey: ["topics"] });
      const previous = qc.getQueryData<Topic[]>(["topics"]);
      if (previous) {
        const rank = new Map(order.map((id, idx) => [id, idx]));
        const next = [...previous].sort(
          (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
        );
        qc.setQueryData<Topic[]>(["topics"], next);
      }
      return { previous };
    },
    onError: (_err, _order, ctx) => {
      if (ctx?.previous) qc.setQueryData(["topics"], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["topics"] }),
  });
}

export function useUpdateRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { title?: string; topic_id?: number } }) =>
      api.updateRecording(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["topics"] });
    },
  });
}

export function useRecordings(topicId?: number) {
  return useQuery({
    queryKey: ["recordings", topicId],
    queryFn: () => api.listRecordings(topicId),
    enabled: topicId != null,
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === "queued" || r.status === "transcribing" || r.status === "diarizing")
        ? 1500
        : false,
  });
}

export function useAllRecordings() {
  return useQuery({
    queryKey: ["recordings", "all"],
    queryFn: () => api.listRecordings(),
    refetchInterval: (query) =>
      query.state.data?.some((recording) =>
        recording.status === "queued" ||
        recording.status === "transcribing" ||
        recording.status === "diarizing"
      )
        ? 1500
        : false,
  });
}

export function useUploadRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ topicId, file, title }: { topicId: number; file: File; title?: string }) =>
      api.uploadRecording(topicId, file, title),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["recordings", vars.topicId] }),
  });
}

// ── Reference documents ───────────────────────────────────────────────────
export function useDocuments(params: {
  topicId?: number;
  recordingId?: number;
  sourceKind?: DocumentSourceKind;
}) {
  return useQuery({
    queryKey: ["documents", params.recordingId ?? null, params.topicId ?? null, params.sourceKind ?? null],
    queryFn: () => api.listDocuments(params),
    enabled: params.recordingId != null || params.topicId != null,
    // Keep polling while any document is still being indexed.
    refetchInterval: (query) =>
      query.state.data?.some((d) => d.status === "uploaded" || d.status === "indexing")
        ? 2000
        : false,
  });
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.uploadDocument,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }),
  });
}

export function useCreateWebContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createWebContext,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }),
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteDocument(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }),
  });
}

export function useDeleteRecording(topicId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteRecording(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["recordings", topicId] });
      // SQLite reuses a deleted row's id, so the next recording can inherit this
      // one's id. Drop every per-recording cache now, otherwise the new recording
      // would show the deleted one's transcript/diarization/summaries/etc.
      for (const key of [
        ["transcript", id],
        ["diarization", id],
        ["summaries", id],
        ["chapters", id],
        ["speaker-stats", id],
        ["latest-job", id],
        ["action-items", "recording", id],
      ]) {
        qc.removeQueries({ queryKey: key });
      }
    },
  });
}

export function useTranscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, asr }: { id: number; asr?: string }) => api.transcribe(id, asr),
    onSuccess: (data, vars) => {
      trackPendingJob(vars.id, data.job_id, "asr");
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["latest-job", vars.id] });
    },
  });
}

/** Re-enqueue a failed job (any phase) for the same recording. */
export function useRetryJob(recordingId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.retryJob(recordingId, jobId),
    onSuccess: (data) => {
      trackPendingJob(recordingId, data.job_id, data.phase);
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["latest-job", recordingId] });
    },
  });
}

export function useTranscript(recordingId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["transcript", recordingId],
    queryFn: () => api.getTranscript(recordingId),
    enabled,
    retry: false,
  });
}

/** Poll the latest job as a fallback when WS events are missed. */
export function useLatestJob(recordingId: number, shouldPoll: boolean) {
  const [enabled, setEnabled] = useState(shouldPoll);
  useEffect(() => {
    if (shouldPoll) setEnabled(true);
  }, [shouldPoll]);
  return useQuery({
    queryKey: ["latest-job", recordingId],
    queryFn: () => api.getJobs(recordingId),
    enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.[0]?.status;
      return status === "done" || status === "failed" || status === "canceled" ? false : 1000;
    },
    select: (jobs) => jobs[0] ?? null,
  });
}

export function useRecordingJobs(recordingId: number, enabled = true) {
  return useQuery({
    queryKey: ["jobs", "recording", recordingId],
    queryFn: () => api.getJobs(recordingId),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.some(
        (job) =>
          job.phase === "action_items" &&
          (job.status === "pending" || job.status === "running"),
      )
        ? 1000
        : false,
  });
}

export function useActiveJobs() {
  return useQuery({
    queryKey: ["jobs", "active"],
    queryFn: api.listActiveJobs,
    refetchInterval: (query) => (query.state.data?.length ? 1000 : 3000),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.cancelJob(jobId),
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ["jobs", "active"] });
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["latest-job", job.recording_id] });
    },
  });
}

export function useDiarize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, params }: { id: number; params?: DiarizeParams }) =>
      api.diarize(id, params),
    onSuccess: (data, vars) => {
      trackPendingJob(vars.id, data.job_id, "diarization");
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["latest-job", vars.id] });
    },
  });
}

export function useDiarization(recordingId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["diarization", recordingId],
    queryFn: () => api.getDiarization(recordingId),
    enabled,
    retry: false,
  });
}

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: api.listTemplates });
}

export function useSummaries(recordingId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["summaries", recordingId],
    queryFn: () => api.listSummaries(recordingId),
    enabled,
  });
}

export function useSummaryProgress(recordingId: number, summaryId: number | null, jobId: number | null) {
  return useQuery({
    queryKey: ["summary-progress", summaryId, jobId],
    queryFn: async () => {
      if (summaryId == null || jobId == null) {
        throw new Error("Summary progress requires a summary and job id.");
      }
      const [summary, jobs] = await Promise.all([
        api.getSummary(summaryId),
        api.getJobs(recordingId),
      ]);
      return { summary, job: jobs.find((job) => job.job_id === jobId) ?? null };
    },
    enabled: summaryId != null && jobId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.job?.status;
      return status === "done" || status === "failed" || status === "canceled" ? false : 500;
    },
  });
}

export function useSummarize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      templateId,
      clarification,
    }: {
      id: number;
      templateId: number;
      clarification?: string;
    }) => api.summarize(id, templateId, clarification),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["summaries", vars.id] }),
  });
}

export function useDeleteSummary(recordingId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteSummary(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["summaries", recordingId] }),
  });
}

export function useLlmConfig() {
  return useQuery({ queryKey: ["llm-config"], queryFn: api.getLlmConfig });
}

// ── Insights: Action-Items, Kapitel, Sprecher-Statistiken ────────────────

export function useActionItems(opts: { topicId?: number | null; done?: boolean | null } = {}) {
  return useQuery({
    queryKey: ["action-items", opts.topicId ?? null, opts.done ?? null],
    queryFn: () => api.listActionItems(opts),
  });
}

export function useProjectMemory() {
  return useQuery({ queryKey: ["project-memory"], queryFn: api.getProjectMemory });
}

export function useMemoryEnrichmentStatus() {
  return useQuery({
    queryKey: ["memory-enrichment"],
    queryFn: api.getMemoryEnrichmentStatus,
    refetchInterval: (query) => {
      const status = query.state.data?.latest_run?.status;
      return status === "pending" || status === "running" ? 1200 : false;
    },
  });
}

export function useStartMemoryEnrichment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.startMemoryEnrichment,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory-enrichment"] }),
  });
}

export function useRetryMemoryEnrichment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.retryMemoryEnrichment,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory-enrichment"] }),
  });
}

export function useRecordingActionItems(recordingId: number, enabled = true) {
  return useQuery({
    queryKey: ["action-items", "recording", recordingId],
    queryFn: () => api.listRecordingActionItems(recordingId),
    enabled,
  });
}

export function useExtractActionItems(recordingId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clarification?: string) => api.extractActionItems(recordingId, clarification),
    onSuccess: (data) => {
      trackPendingJob(recordingId, data.job_id, "action_items");
      qc.invalidateQueries({ queryKey: ["latest-job", recordingId] });
      qc.invalidateQueries({ queryKey: ["jobs", "recording", recordingId] });
    },
  });
}

export function useUpdateActionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: number;
      patch: Partial<
        Pick<
          ActionItem,
          | "done"
          | "text"
          | "assignee"
          | "recipient"
          | "due"
          | "due_date"
          | "review_state"
          | "decision_status"
          | "superseded_by_id"
          | "include_in_tasks"
        >
      >;
    }) => api.updateActionItem(id, patch),
    // Prefix match also refreshes the per-recording list (["action-items","recording",id]).
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action-items"] });
      qc.invalidateQueries({ queryKey: ["project-memory"] });
    },
  });
}

export function useDeleteActionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteActionItem(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action-items"] });
      qc.invalidateQueries({ queryKey: ["project-memory"] });
    },
  });
}

export function useSyncActionItemCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.syncActionItemCalendar(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["action-items"] }),
  });
}

export function useChapters(recordingId: number, enabled = true) {
  return useQuery({
    queryKey: ["chapters", recordingId],
    queryFn: () => api.listChapters(recordingId),
    enabled,
  });
}

export function useGenerateChapters(recordingId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.generateChapters(recordingId),
    onSuccess: (data) => {
      trackPendingJob(recordingId, data.job_id, "chapters");
      qc.invalidateQueries({ queryKey: ["latest-job", recordingId] });
    },
  });
}

export function useSpeakerStats(recordingId: number, enabled = true) {
  return useQuery({
    queryKey: ["speaker-stats", recordingId],
    queryFn: () => api.getSpeakerStats(recordingId),
    enabled,
    retry: false,
  });
}

export function useDigests() {
  return useQuery({ queryKey: ["digests"], queryFn: api.listDigests });
}

export function useCreateDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number = 7) => api.createDigest(days),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["digests"] }),
  });
}

export function useSendDigestToFolder() {
  return useMutation({
    mutationFn: (id: number) => api.sendDigestToFolder(id),
  });
}

export function useThreads() {
  return useQuery({ queryKey: ["threads"], queryFn: api.listThreads });
}

export function useRebuildThreads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.rebuildThreads,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["threads"] }),
  });
}

export function useKnownSpeakers() {
  return useQuery({ queryKey: ["known-speakers"], queryFn: api.listKnownSpeakers });
}

export function usePeopleMemory(speakerId: number | null) {
  return useQuery({
    queryKey: ["people-memory", speakerId],
    queryFn: () => api.getPeopleMemory(speakerId!),
    enabled: speakerId != null,
  });
}

export function useDeleteKnownSpeaker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteKnownSpeaker(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["known-speakers"] }),
  });
}

export function useEnrollSpeaker(recordingId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label, name, knownSpeakerId }: { label: string; name: string; knownSpeakerId?: number }) =>
      api.enrollSpeaker(recordingId, label, name, knownSpeakerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["known-speakers"] });
      qc.invalidateQueries({ queryKey: ["diarization", recordingId] });
    },
  });
}

export function useSpeakerEdits(recordingId: number) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["diarization", recordingId] });
  return {
    rename: useMutation({
      mutationFn: ({ label, name }: { label: string; name: string }) =>
        api.renameSpeaker(recordingId, label, name),
      onSuccess: invalidate,
    }),
    merge: useMutation({
      mutationFn: ({ from, to }: { from: string; to: string }) =>
        api.mergeSpeakers(recordingId, from, to),
      onSuccess: invalidate,
    }),
    reassign: useMutation({
      mutationFn: ({ start, end, speaker }: { start: number; end: number; speaker: string }) =>
        api.reassignSegment(recordingId, start, end, speaker),
      onSuccess: invalidate,
    }),
    reset: useMutation({
      mutationFn: () => api.resetOverlay(recordingId),
      onSuccess: invalidate,
    }),
  };
}
