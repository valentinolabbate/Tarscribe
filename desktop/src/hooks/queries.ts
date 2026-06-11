import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DiarizeParams } from "../lib/api";
import type { ActionItem } from "../lib/types";
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
      patch: { name?: string; color?: string; export_path?: string };
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

export function useUpdateRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { title?: string; topic_id?: number } }) =>
      api.updateRecording(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
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

export function useUploadRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ topicId, file, title }: { topicId: number; file: File; title?: string }) =>
      api.uploadRecording(topicId, file, title),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["recordings", vars.topicId] }),
  });
}

export function useDeleteRecording(topicId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteRecording(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recordings", topicId] }),
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
      const [summary, jobs] = await Promise.all([
        api.getSummary(summaryId!),
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
    mutationFn: ({ id, templateId }: { id: number; templateId: number }) =>
      api.summarize(id, templateId),
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
    mutationFn: () => api.extractActionItems(recordingId),
    onSuccess: (data) => {
      trackPendingJob(recordingId, data.job_id, "action_items");
      qc.invalidateQueries({ queryKey: ["latest-job", recordingId] });
    },
  });
}

export function useUpdateActionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<ActionItem, "done" | "text" | "assignee" | "due">> }) =>
      api.updateActionItem(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["action-items"] }),
  });
}

export function useDeleteActionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteActionItem(id),
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

export function useKnownSpeakers() {
  return useQuery({ queryKey: ["known-speakers"], queryFn: api.listKnownSpeakers });
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
