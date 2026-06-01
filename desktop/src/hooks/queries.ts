import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DiarizeParams } from "../lib/api";

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
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

export function useDiarize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, params }: { id: number; params?: DiarizeParams }) =>
      api.diarize(id, params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
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
