import type {
  ActionItem,
  AppSettings,
  Chapter,
  ChatMessage,
  DebugJob,
  DiarizationData,
  Digest,
  DictationResult,
  HardwareInfo,
  JobEvent,
  KnownSpeaker,
  LlmConfig,
  LiveEvent,
  LiveSession,
  McpInfo,
  RagConfig,
  RagHit,
  RagSource,
  RagStatus,
  Recording,
  SpeakerStats,
  Summary,
  SummaryEvent,
  SummaryTemplate,
  TranscriptData,
  Topic,
  TopicDocument,
  TopicThread,
} from "./types";

export interface SearchFilters {
  topicId?: number | null;
  recordingId?: number | null;
  topK?: number;
  speaker?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface DiarizeParams {
  num_speakers?: number | null;
  min_speakers?: number | null;
  max_speakers?: number | null;
  clustering_threshold?: number | null;
  min_duration_off?: number | null;
}

interface BackendConfig {
  base_url: string;
  token: string;
}

let configPromise: Promise<BackendConfig> | null = null;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function resolveConfig(): Promise<BackendConfig> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    // The Rust shell may still be spawning the sidecar; retry briefly.
    let lastErr: unknown;
    for (let i = 0; i < 50; i++) {
      try {
        return await invoke<BackendConfig>("backend_config");
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr;
  }
  // Browser dev fallback: talk to a manually started backend.
  const base = import.meta.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8765";
  return { base_url: base, token: import.meta.env.VITE_BACKEND_TOKEN ?? "" };
}

export function getConfig(): Promise<BackendConfig> {
  if (!configPromise) configPromise = resolveConfig();
  return configPromise;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = await getConfig();
  const headers = new Headers(init?.headers);
  if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
  const res = await fetch(`${cfg.base_url}${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Wait until the backend answers /health, so the UI can show a splash. */
export async function waitForBackend(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await request("/api/system/health");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("Backend nicht erreichbar");
}

export const api = {
  health: () => request<{ status: string; version: string }>("/api/system/health"),
  hardware: () => request<HardwareInfo>("/api/system/hardware"),
  setupStatus: () =>
    request<{
      setup_complete: boolean;
      ffmpeg_available: boolean;
      hf_token_set: boolean;
      llm_configured: boolean;
      hardware: HardwareInfo;
    }>("/api/system/setup-status"),
  completeSetup: () =>
    request<{ setup_complete: boolean }>("/api/system/complete-setup", { method: "POST" }),
  warmup: () => request<{ ok: boolean; engine: string }>("/api/system/warmup", { method: "POST" }),
  setCaldavPassword: (password: string) =>
    request<{ saved: boolean; caldav_password_set: boolean }>("/api/settings/caldav-password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  deleteCaldavPassword: () =>
    request<{ saved: boolean; caldav_password_set: boolean }>("/api/settings/caldav-password", {
      method: "DELETE",
    }),
  testCaldav: (payload: { url?: string; username?: string; password?: string }) =>
    request<{ ok: boolean; status?: number; error?: string }>("/api/settings/caldav/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  listTopics: () => request<Topic[]>("/api/topics"),
  createTopic: (name: string, color?: string) =>
    request<Topic>("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color }),
    }),
  updateTopic: (
    id: number,
    patch: Partial<Pick<Topic, "name" | "color" | "export_path" | "calendar_export_mode" | "calendar_url">>,
  ) =>
    request<Topic>(`/api/topics/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  sendToFolder: (id: number) =>
    request<{ path: string }>(`/api/recordings/${id}/send-to-folder`, { method: "POST" }),
  deleteTopic: (id: number) => request<void>(`/api/topics/${id}`, { method: "DELETE" }),
  reorderTopics: (order: number[]) =>
    request<void>("/api/topics/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    }),

  listRecordings: (topicId?: number) =>
    request<Recording[]>(`/api/recordings${topicId != null ? `?topic_id=${topicId}` : ""}`),
  getRecording: (id: number) => request<Recording>(`/api/recordings/${id}`),
  uploadRecording: (topicId: number, file: File, title?: string) => {
    const form = new FormData();
    form.set("topic_id", String(topicId));
    if (title) form.set("title", title);
    form.set("file", file);
    return request<Recording>("/api/recordings", { method: "POST", body: form });
  },
  importLocalRecording: (topicId: number, path: string, title?: string) =>
    request<Recording>("/api/recordings/import-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic_id: topicId, path, title }),
    }),
  importMixedLocalRecording: (topicId: number, path: string, microphone: Blob, title?: string) => {
    const form = new FormData();
    form.set("topic_id", String(topicId));
    form.set("path", path);
    if (title) form.set("title", title);
    form.set("microphone", microphone, "microphone.webm");
    return request<Recording>("/api/recordings/import-local-mixed", { method: "POST", body: form });
  },
  updateRecording: (id: number, patch: { title?: string; topic_id?: number }) =>
    request<Recording>(`/api/recordings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteRecording: (id: number) =>
    request<void>(`/api/recordings/${id}`, { method: "DELETE" }),

  // ── Reference documents (RAG-indexed) ──────────────────────────────────
  listDocuments: (params: { topicId?: number; recordingId?: number }) => {
    const qs = new URLSearchParams();
    if (params.recordingId != null) qs.set("recording_id", String(params.recordingId));
    else if (params.topicId != null) qs.set("topic_id", String(params.topicId));
    return request<TopicDocument[]>(`/api/documents?${qs.toString()}`);
  },
  uploadDocument: (params: { topicId: number; recordingId?: number; file: File; title?: string }) => {
    const form = new FormData();
    form.set("topic_id", String(params.topicId));
    if (params.recordingId != null) form.set("recording_id", String(params.recordingId));
    if (params.title) form.set("title", params.title);
    form.set("file", params.file);
    return request<TopicDocument>("/api/documents", { method: "POST", body: form });
  },
  reindexDocument: (id: number) =>
    request<{ enqueued: boolean }>(`/api/documents/${id}/reindex`, { method: "POST" }),
  deleteDocument: (id: number) =>
    request<void>(`/api/documents/${id}`, { method: "DELETE" }),
  async openDocument(id: number): Promise<void> {
    // Fetch with the auth header, then trigger a download (works in Tauri and
    // the browser dev shell where opening a remote URL directly would 401).
    const cfg = await getConfig();
    const headers = new Headers();
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    const res = await fetch(`${cfg.base_url}/api/documents/${id}/file`, { headers });
    if (!res.ok) throw new Error("Dokument konnte nicht geladen werden");
    const cd = res.headers.get("Content-Disposition");
    const match = cd ? /filename="?([^"]+)"?/.exec(cd) : null;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = match ? match[1] : "dokument";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  transcribe: (id: number, asr?: string) =>
    request<{ job_id: number; status: string }>(
      `/api/recordings/${id}/transcribe${asr ? `?asr=${asr}` : ""}`,
      { method: "POST" },
    ),
  getTranscript: (id: number) =>
    request<TranscriptData>(`/api/recordings/${id}/transcript`),
  getJobs: (id: number) =>
    request<JobEvent[]>(`/api/recordings/${id}/jobs`),
  listActiveJobs: () => request<DebugJob[]>("/api/jobs"),
  cancelJob: (jobId: number) =>
    request<DebugJob>(`/api/jobs/${jobId}/cancel`, { method: "POST" }),
  retryJob: (recordingId: number, jobId: number) =>
    request<{ job_id: number; phase: string; status: string }>(
      `/api/recordings/${recordingId}/jobs/${jobId}/retry`,
      { method: "POST" },
    ),
  diarize: (id: number, params?: DiarizeParams) =>
    request<{ job_id: number; status: string }>(`/api/recordings/${id}/diarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params ?? {}),
    }),
  getDiarization: (id: number) =>
    request<DiarizationData>(`/api/recordings/${id}/diarization`),
  renameSpeaker: (id: number, label: string, name: string) =>
    request<{ ok: boolean }>(`/api/recordings/${id}/speakers/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, name }),
    }),
  mergeSpeakers: (id: number, fromLabel: string, toLabel: string) =>
    request<{ ok: boolean }>(`/api/recordings/${id}/speakers/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_label: fromLabel, to_label: toLabel }),
    }),
  reassignSegment: (id: number, start: number, end: number, speaker: string) =>
    request<{ ok: boolean }>(`/api/recordings/${id}/segments/reassign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start, end, speaker }),
    }),
  resetOverlay: (id: number) =>
    request<{ ok: boolean }>(`/api/recordings/${id}/edits/reset`, { method: "POST" }),

  listKnownSpeakers: () => request<KnownSpeaker[]>("/api/known-speakers"),
  deleteKnownSpeaker: (id: number) =>
    request<void>(`/api/known-speakers/${id}`, { method: "DELETE" }),
  enrollSpeaker: (recordingId: number, label: string, name: string, knownSpeakerId?: number) =>
    request<KnownSpeaker>(`/api/recordings/${recordingId}/speakers/${label}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, known_speaker_id: knownSpeakerId ?? null }),
    }),
  matchRecording: (recordingId: number) =>
    request<{ matches: { label: string; name: string; score: number }[] }>(
      `/api/recordings/${recordingId}/match`,
      { method: "POST" },
    ),

  // Templates
  listTemplates: () => request<SummaryTemplate[]>("/api/templates"),
  createTemplate: (t: Omit<SummaryTemplate, "id" | "is_builtin">) =>
    request<SummaryTemplate>("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t),
    }),
  updateTemplate: (id: number, t: Omit<SummaryTemplate, "id" | "is_builtin">) =>
    request<SummaryTemplate>(`/api/templates/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t),
    }),
  duplicateTemplate: (id: number) =>
    request<SummaryTemplate>(`/api/templates/${id}/duplicate`, { method: "POST" }),
  deleteTemplate: (id: number) =>
    request<void>(`/api/templates/${id}`, { method: "DELETE" }),

  // LLM
  getLlmConfig: () => request<LlmConfig>("/api/llm/config"),
  setLlmConfig: (cfg: LlmConfig) =>
    request<LlmConfig>("/api/llm/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  listLlmModels: (baseUrl?: string) =>
    request<{ models: string[] }>(`/api/llm/models${baseUrl ? `?base_url=${encodeURIComponent(baseUrl)}` : ""}`),
  testLlm: (baseUrl?: string) =>
    request<{ ok: boolean; models?: string[]; error?: string }>("/api/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: baseUrl }),
    }),
  setLlmApiKey: (apiKey: string, baseUrl?: string) =>
    request<{ saved: boolean; ok?: boolean; models?: string[]; error?: string; api_key_set: boolean }>(
      "/api/llm/api-key",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, base_url: baseUrl }),
      },
    ),
  deleteLlmApiKey: () =>
    request<{ saved: boolean; api_key_set: boolean }>("/api/llm/api-key", { method: "DELETE" }),

  // RAG / Wissens-Chat
  getRagConfig: () => request<RagConfig>("/api/rag/config"),
  setRagConfig: (cfg: RagConfig) =>
    request<RagConfig>("/api/rag/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  listRagModels: (baseUrl?: string) =>
    request<{ models: string[] }>(
      `/api/rag/models${baseUrl ? `?base_url=${encodeURIComponent(baseUrl)}` : ""}`,
    ),
  testRag: (baseUrl?: string) =>
    request<{ ok: boolean; models?: string[]; error?: string }>("/api/rag/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: baseUrl }),
    }),
  setRagApiKey: (apiKey: string, baseUrl?: string) =>
    request<{ saved: boolean; ok?: boolean; models?: string[]; error?: string; api_key_set: boolean }>(
      "/api/rag/api-key",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, base_url: baseUrl }),
      },
    ),
  deleteRagApiKey: () =>
    request<{ saved: boolean; api_key_set: boolean }>("/api/rag/api-key", { method: "DELETE" }),
  getRagStatus: () => request<RagStatus>("/api/rag/status"),
  reindexRag: () => request<{ enqueued: number }>("/api/rag/reindex", { method: "POST" }),
  ragSearch: (query: string, opts: SearchFilters = {}) =>
    request<{ hits: RagHit[] }>("/api/rag/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        topic_id: opts.topicId ?? null,
        recording_id: opts.recordingId ?? null,
        top_k: opts.topK ?? null,
        speaker: opts.speaker || null,
        date_from: opts.dateFrom || null,
        date_to: opts.dateTo || null,
      }),
    }),

  /** Stream a RAG chat answer (SSE): sources first, then content deltas. */
  async ragChat(
    messages: ChatMessage[],
    opts: SearchFilters = {},
    handlers: {
      onSources?: (s: RagSource[]) => void;
      onDelta?: (text: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const cfg = await getConfig();
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    const res = await fetch(`${cfg.base_url}/api/rag/chat`, {
      method: "POST",
      headers,
      signal: handlers.signal,
      body: JSON.stringify({
        messages,
        topic_id: opts.topicId ?? null,
        recording_id: opts.recordingId ?? null,
        top_k: opts.topK ?? null,
        speaker: opts.speaker || null,
        date_from: opts.dateFrom || null,
        date_to: opts.dateTo || null,
      }),
    });
    if (!res.ok || !res.body) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail ?? detail; } catch { /* ignore */ }
      throw new Error(detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let evt: { type: string; sources?: RagSource[]; content?: string; error?: string };
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === "sources") handlers.onSources?.(evt.sources ?? []);
        else if (evt.type === "delta") handlers.onDelta?.(evt.content ?? "");
        else if (evt.type === "error") throw new Error(evt.error ?? "Chat-Fehler");
      }
    }
  },

  // Insights: Action-Items, Kapitel, Sprecher-Statistiken
  extractActionItems: (recordingId: number) =>
    request<{ job_id: number; status: string }>(
      `/api/recordings/${recordingId}/action-items/extract`,
      { method: "POST" },
    ),
  listRecordingActionItems: (recordingId: number) =>
    request<ActionItem[]>(`/api/recordings/${recordingId}/action-items`),
  listActionItems: (opts: { topicId?: number | null; done?: boolean | null } = {}) => {
    const params = new URLSearchParams();
    if (opts.topicId != null) params.set("topic_id", String(opts.topicId));
    if (opts.done != null) params.set("done", String(opts.done));
    const qs = params.toString();
    return request<ActionItem[]>(`/api/action-items${qs ? `?${qs}` : ""}`);
  },
  updateActionItem: (
    id: number,
    patch: Partial<
      Pick<ActionItem, "done" | "text" | "assignee" | "due" | "due_date" | "include_in_tasks">
    >,
  ) =>
    request<ActionItem>(`/api/action-items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteActionItem: (id: number) =>
    request<void>(`/api/action-items/${id}`, { method: "DELETE" }),
  syncActionItemCalendar: (id: number) =>
    request<ActionItem>(`/api/action-items/${id}/calendar-sync`, { method: "POST" }),
  async downloadActionItemsIcs(topicId?: number | null): Promise<void> {
    const cfg = await getConfig();
    const headers = new Headers();
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    const qs = topicId != null ? `?topic_id=${topicId}` : "";
    const res = await fetch(`${cfg.base_url}/api/action-items/export.ics${qs}`, { headers });
    if (!res.ok) {
      let detail = "Kalender-Export fehlgeschlagen";
      try {
        detail = (await res.json()).detail ?? detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Tarscribe Aufgaben.ics";
    a.click();
    URL.revokeObjectURL(url);
  },

  generateChapters: (recordingId: number) =>
    request<{ job_id: number; status: string }>(
      `/api/recordings/${recordingId}/chapters/generate`,
      { method: "POST" },
    ),
  listChapters: (recordingId: number) =>
    request<Chapter[]>(`/api/recordings/${recordingId}/chapters`),
  deleteChapters: (recordingId: number) =>
    request<void>(`/api/recordings/${recordingId}/chapters`, { method: "DELETE" }),
  async downloadChapters(id: number, format: "youtube" | "srt", title: string): Promise<void> {
    const cfg = await getConfig();
    const headers = new Headers();
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    const res = await fetch(
      `${cfg.base_url}/api/recordings/${id}/chapters/export?format=${format}`,
      { headers },
    );
    if (!res.ok) throw new Error("Kapitel-Export fehlgeschlagen");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title} Kapitel.${format === "srt" ? "srt" : "txt"}`;
    a.click();
    URL.revokeObjectURL(url);
  },

  getSpeakerStats: (recordingId: number) =>
    request<SpeakerStats>(`/api/recordings/${recordingId}/speaker-stats`),

  // Wochen-Digest
  listDigests: () => request<Digest[]>("/api/digests"),
  getDigest: (id: number) => request<Digest>(`/api/digests/${id}`),
  createDigest: (days = 7) =>
    request<Digest>(`/api/digests?days=${days}`, { method: "POST" }),
  sendDigestToFolder: (id: number) =>
    request<{ path: string }>(`/api/digests/${id}/send-to-folder`, { method: "POST" }),
  listThreads: () => request<TopicThread[]>("/api/threads"),
  rebuildThreads: () => request<{ threads: number; mentions: number }>("/api/threads/rebuild", { method: "POST" }),
  listRecordingThreads: (recordingId: number) =>
    request<TopicThread[]>(`/api/recordings/${recordingId}/threads`),

  createDictation: (file: File, title?: string) => {
    const form = new FormData();
    if (title) form.set("title", title);
    form.set("file", file);
    return request<DictationResult>("/api/dictations", { method: "POST", body: form });
  },

  // Summaries
  summarize: (recordingId: number, templateId: number) =>
    request<{ job_id: number; summary_id: number }>(
      `/api/recordings/${recordingId}/summarize?template_id=${templateId}`,
      { method: "POST" },
    ),
  listSummaries: (recordingId: number) =>
    request<Summary[]>(`/api/recordings/${recordingId}/summaries`),
  getSummary: (id: number) => request<Summary>(`/api/summaries/${id}`),
  deleteSummary: (id: number) => request<void>(`/api/summaries/${id}`, { method: "DELETE" }),
  async downloadExport(id: number, format: string, title: string): Promise<void> {
    const cfg = await getConfig();
    const headers = new Headers();
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    const res = await fetch(`${cfg.base_url}/api/recordings/${id}/export?format=${format}`, {
      headers,
    });
    if (!res.ok) throw new Error("Export fehlgeschlagen");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
  getSettings: () => request<AppSettings>("/api/settings"),
  updateSettings: (patch: Partial<Omit<AppSettings, "hf_token_set" | "caldav_password_set">>) =>
    request<AppSettings>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  setHfToken: (token: string) =>
    request<{ saved: boolean; valid: boolean; name?: string; error?: string }>(
      "/api/settings/hf-token",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    ),
  validateHfToken: () =>
    request<{ valid: boolean; name?: string; error?: string }>(
      "/api/settings/hf-token/validate",
      { method: "POST" },
    ),
  deleteHfToken: () => request<void>("/api/settings/hf-token", { method: "DELETE" }),

  // Live recording sessions
  createLiveSession: (topicId: number, title: string) =>
    request<LiveSession>("/api/live-recordings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic_id: topicId, title }),
    }),
  getLiveSession: (sessionId: string) =>
    request<LiveSession>(`/api/live-recordings/${sessionId}`),
  pauseLiveSession: (sessionId: string) =>
    request<{ status: string }>(`/api/live-recordings/${sessionId}/pause`, { method: "POST" }),
  resumeLiveSession: (sessionId: string) =>
    request<{ status: string }>(`/api/live-recordings/${sessionId}/resume`, { method: "POST" }),
  finishLiveSession: (sessionId: string, recordingId: number | null) =>
    request<{ status: string; recording_id: number | null }>(
      `/api/live-recordings/${sessionId}/finish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recording_id: recordingId }),
      },
    ),
  cancelLiveSession: (sessionId: string) =>
    request<void>(`/api/live-recordings/${sessionId}`, { method: "DELETE" }),
  async uploadPcmChunk(
    sessionId: string,
    chunk: ArrayBuffer,
    sequenceNumber: number,
    sampleRate = 16000,
    channels = 1,
  ): Promise<{ accepted: boolean; last_sequence_number: number; received_duration_sec: number }> {
    const cfg = await getConfig();
    const headers = new Headers();
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("X-Sequence-Number", String(sequenceNumber));
    headers.set("X-Sample-Rate", String(sampleRate));
    headers.set("X-Channels", String(channels));
    const res = await fetch(`${cfg.base_url}/api/live-recordings/${sessionId}/chunks`, {
      method: "POST",
      headers,
      body: chunk,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail ?? detail; } catch { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  },

  /** Open a WebSocket for live job + summary streaming. Returns a cleanup function. */
  async connectJobs(
    onEvent: (e: JobEvent) => void,
    onSummary?: (e: SummaryEvent) => void,
    onLive?: (e: LiveEvent) => void,
  ): Promise<() => void> {
    const cfg = await getConfig();
    const url =
      cfg.base_url.replace(/^http/, "ws") +
      "/ws" +
      (cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : "");
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const LIVE_TYPES = new Set(["live_session", "live_transcript", "live_speakers", "live_finalized", "live_degraded", "live_error"]);

    const connect = () => {
      if (closed) return;
      const socket = new WebSocket(url);
      ws = socket;
      socket.onmessage = (m) => {
        try {
          const data = JSON.parse(m.data);
          if (data?.type === "job") onEvent(data as JobEvent);
          else if (data?.type === "summary") onSummary?.(data as SummaryEvent);
          else if (LIVE_TYPES.has(data?.type)) onLive?.(data as LiveEvent);
        } catch {
          /* ignore */
        }
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (!closed) reconnect = setTimeout(connect, 1000);
      };
      socket.onerror = () => socket.close();
    };
    connect();
    // Keep-alive ping so the server's receive loop stays happy.
    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 20000);
    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(reconnect);
      ws?.close();
    };
  },
  async downloadAudio(id: number, title: string): Promise<void> {
    const cfg = await getConfig();
    const headers = new Headers();
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    const res = await fetch(`${cfg.base_url}/api/recordings/${id}/audio`, { headers });
    if (!res.ok) throw new Error("Audio-Export fehlgeschlagen");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  },
  async audioUrl(id: number): Promise<string> {
    // Fetch with auth header, return an object URL for <audio>/wavesurfer.
    const cfg = await getConfig();
    const headers = new Headers();
    if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
    const res = await fetch(`${cfg.base_url}/api/recordings/${id}/audio`, { headers });
    if (!res.ok) throw new Error("Audio konnte nicht geladen werden");
    return URL.createObjectURL(await res.blob());
  },

  // MCP (agent integration)
  getMcpInfo: () => request<McpInfo>("/api/mcp/info"),
  registerMcp: (targetId: string) =>
    request<{ registered: boolean; path: string; id: string }>(
      `/api/mcp/register/${targetId}`,
      { method: "POST" },
    ),
  unregisterMcp: (targetId: string) =>
    request<{ registered: boolean; removed: boolean; path: string; id: string }>(
      `/api/mcp/register/${targetId}`,
      { method: "DELETE" },
    ),
};
