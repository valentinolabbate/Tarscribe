import type {
  ActionItem,
  AppSettings,
  Chapter,
  ChatMessage,
  ChatScope,
  ChatSession,
  ChatStoredMessage,
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
  McpDiagnostics,
  McpInfo,
  McpRegistrationResult,
  ModelStatusPayload,
  RagConfig,
  RagHit,
  RagSource,
  RagStatus,
  Recording,
  SecretStorageStatus,
  SpeakerStats,
  Summary,
  SummaryEvent,
  SummaryTemplate,
  TranscriptData,
  Topic,
  TopicDocument,
  TopicThread,
} from "./types";
import {
  convertLocalFileSrc,
  invoke as tauriInvoke,
  isTauri as isTauriRuntime,
  listen as tauriListen,
} from "./tauri";

export interface SearchFilters {
  topicId?: number | null;
  recordingId?: number | null;
  includeTopicContext?: boolean;
  topK?: number;
  speaker?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface RagChatOptions extends SearchFilters {
  reasoningEffort?: string | null;
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
  token?: string;
}

const WS_SUBPROTOCOL = "tarscribe";
const WS_AUTH_SUBPROTOCOL_PREFIX = "tarscribe-auth-";

interface ProxyHeader {
  name: string;
  value: string;
}

interface ProxyResponse {
  status: number;
  headers: ProxyHeader[];
  body: number[];
}

let configPromise: Promise<BackendConfig> | null = null;

async function resolveConfig(): Promise<BackendConfig> {
  if (isTauriRuntime()) {
    // The Rust shell may still be spawning the sidecar; retry briefly.
    let lastErr: unknown;
    for (let i = 0; i < 50; i++) {
      try {
        return await tauriInvoke<BackendConfig>("backend_config");
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

function proxyHeaders(headers: Headers): ProxyHeader[] {
  return [...headers.entries()].map(([name, value]) => ({ name, value }));
}

function bytesFromBuffer(buffer: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buffer));
}

async function proxyBody(body: BodyInit | null | undefined, headers: Headers): Promise<number[] | null> {
  if (body == null) return null;
  if (body instanceof FormData) {
    const req = new Request("http://tarscribe.local/proxy-body", { method: "POST", body });
    const contentType = req.headers.get("Content-Type");
    if (contentType && !headers.has("Content-Type")) headers.set("Content-Type", contentType);
    return bytesFromBuffer(await req.arrayBuffer());
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
    return bytesFromBuffer(new TextEncoder().encode(body.toString()).buffer);
  }
  if (typeof body === "string") {
    return bytesFromBuffer(new TextEncoder().encode(body).buffer);
  }
  if (body instanceof Blob) {
    if (body.type && !headers.has("Content-Type")) headers.set("Content-Type", body.type);
    return bytesFromBuffer(await body.arrayBuffer());
  }
  if (body instanceof ArrayBuffer) {
    return bytesFromBuffer(body);
  }
  if (ArrayBuffer.isView(body)) {
    const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return Array.from(view);
  }
  throw new Error("Dieser Request-Body kann nicht über den Tauri-Proxy gesendet werden");
}

async function proxyFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const body = await proxyBody(init?.body, headers);
  const res = await tauriInvoke<ProxyResponse>("proxy_request", {
    method: init?.method ?? "GET",
    path,
    headers: proxyHeaders(headers),
    body,
  });
  const responseHeaders = new Headers();
  for (const header of res.headers) responseHeaders.set(header.name, header.value);
  const responseBody =
    res.body.length > 0 && ![204, 205, 304].includes(res.status)
      ? new Uint8Array(res.body)
      : null;
  return new Response(responseBody, { status: res.status, headers: responseHeaders });
}

async function directFetch(path: string, init?: RequestInit): Promise<Response> {
  const cfg = await getConfig();
  const headers = new Headers(init?.headers);
  if (cfg.token) headers.set("X-Tarscribe-Token", cfg.token);
  return fetch(`${cfg.base_url}${path}`, { ...init, headers });
}

async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  return isTauriRuntime() ? proxyFetch(path, init) : directFetch(path, init);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await backendFetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const rawDetail = (await res.json()).detail ?? detail;
      detail =
        typeof rawDetail === "string"
          ? rawDetail
          : rawDetail?.error
            ? String(rawDetail.error)
            : JSON.stringify(rawDetail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function downloadFilenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].replace(/^"|"$/g, ""));
    } catch {
      return encoded[1].replace(/^"|"$/g, "");
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(value);
  if (quoted) return quoted[1];
  const plain = /filename=([^;]+)/i.exec(value);
  return plain ? plain[1].trim().replace(/^"|"$/g, "") : null;
}

export async function downloadBlob(path: string, filename: string, options?: RequestInit): Promise<void> {
  const res = await backendFetch(path, options);
  if (!res.ok) {
    let detail = res.statusText || "Download fehlgeschlagen";
    try {
      const rawDetail = (await res.json()).detail ?? detail;
      detail = typeof rawDetail === "string" ? rawDetail : JSON.stringify(rawDetail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const objectUrl = URL.createObjectURL(await res.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = downloadFilenameFromContentDisposition(res.headers.get("Content-Disposition")) ?? filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}

/** Wait until the backend answers /health, so the UI can show a splash. */
export async function waitForBackend(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await request("/api/health");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("Backend nicht erreichbar");
}

export const api = {
  health: () => request<{ status: string }>("/api/health"),
  hardware: () => request<HardwareInfo>("/api/system/hardware"),
  modelStatus: () => request<ModelStatusPayload>("/api/system/models"),
  setupStatus: () =>
    request<{
      setup_complete: boolean;
      ffmpeg_available: boolean;
      hf_token_set: boolean;
      llm_configured: boolean;
      secret_storage: SecretStorageStatus;
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
    await downloadBlob(`/api/documents/${id}/file`, "dokument");
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
  listChatSessions: (opts: { scope?: ChatScope; recordingId?: number | null; topicId?: number | null } = {}) => {
    const qs = new URLSearchParams();
    if (opts.scope) qs.set("scope", opts.scope);
    if (opts.recordingId != null) qs.set("recording_id", String(opts.recordingId));
    if (opts.topicId != null) qs.set("topic_id", String(opts.topicId));
    const suffix = qs.toString();
    return request<ChatSession[]>(`/api/chats${suffix ? `?${suffix}` : ""}`);
  },
  createChatSession: (payload: {
    scope: ChatScope;
    title?: string;
    recording_id?: number | null;
    topic_id?: number | null;
  }) =>
    request<ChatSession>("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  getChatSession: (id: number) => request<ChatSession>(`/api/chats/${id}`),
  updateChatSession: (id: number, patch: { title?: string; archived?: boolean }) =>
    request<ChatSession>(`/api/chats/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteChatSession: (id: number) => request<void>(`/api/chats/${id}`, { method: "DELETE" }),
  addChatMessage: (
    chatId: number,
    message: ChatMessage & { sources?: RagSource[] | null },
  ) =>
    request<ChatStoredMessage>(`/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    }),
  ragSearch: (query: string, opts: SearchFilters = {}) =>
    request<{ hits: RagHit[] }>("/api/rag/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        topic_id: opts.topicId ?? null,
        recording_id: opts.recordingId ?? null,
        include_topic_context: opts.includeTopicContext ?? false,
        top_k: opts.topK ?? null,
        speaker: opts.speaker || null,
        date_from: opts.dateFrom || null,
        date_to: opts.dateTo || null,
      }),
    }),

  /** Stream a RAG chat answer (SSE): sources first, then content deltas. */
  async ragChat(
    messages: ChatMessage[],
    opts: RagChatOptions = {},
    handlers: {
      onSources?: (s: RagSource[]) => void;
      onDelta?: (text: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    const res = await backendFetch("/api/rag/chat", {
      method: "POST",
      headers,
      signal: handlers.signal,
      body: JSON.stringify({
        messages,
        topic_id: opts.topicId ?? null,
        recording_id: opts.recordingId ?? null,
        include_topic_context: opts.includeTopicContext ?? false,
        reasoning_effort: opts.reasoningEffort || null,
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
  extractActionItems: (recordingId: number, clarification?: string) =>
    request<{ job_id: number; status: string }>(
      `/api/recordings/${recordingId}/action-items/extract`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clarification: clarification?.trim() || null }),
      },
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
    const qs = topicId != null ? `?topic_id=${topicId}` : "";
    await downloadBlob(`/api/action-items/export.ics${qs}`, "Tarscribe Aufgaben.ics");
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
    await downloadBlob(
      `/api/recordings/${id}/chapters/export?format=${format}`,
      `${title} Kapitel.${format === "srt" ? "srt" : "txt"}`,
    );
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
  summarize: (recordingId: number, templateId: number, clarification?: string) =>
    request<{ job_id: number; summary_id: number }>(
      `/api/recordings/${recordingId}/summarize?template_id=${templateId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clarification: clarification?.trim() || null }),
      },
    ),
  listSummaries: (recordingId: number) =>
    request<Summary[]>(`/api/recordings/${recordingId}/summaries`),
  getSummary: (id: number) => request<Summary>(`/api/summaries/${id}`),
  updateSummary: (id: number, content: string, revision: number) =>
    request<Summary>(`/api/summaries/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, revision }),
    }),
  async downloadSummaryPdf(id: number, title: string): Promise<void> {
    await downloadBlob(
      `/api/summaries/${id}/export.pdf`,
      `${title} - Zusammenfassung.pdf`,
    );
  },
  deleteSummary: (id: number) => request<void>(`/api/summaries/${id}`, { method: "DELETE" }),
  async downloadExport(id: number, format: string, title: string): Promise<void> {
    await downloadBlob(`/api/recordings/${id}/export?format=${format}`, `${title}.${format}`);
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
    request<{ status: string; recording_id: number | null; transcription_job_id: number | null }>(
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
    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("X-Sequence-Number", String(sequenceNumber));
    headers.set("X-Sample-Rate", String(sampleRate));
    headers.set("X-Channels", String(channels));
    const res = await backendFetch(`/api/live-recordings/${sessionId}/chunks`, {
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
    const LIVE_TYPES = new Set(["live_session", "live_transcript", "live_speakers", "live_finalized", "live_degraded", "live_error"]);
    const handleMessage = (raw: string) => {
      try {
        const data = JSON.parse(raw);
        if (data?.type === "job") onEvent(data as JobEvent);
        else if (data?.type === "summary") onSummary?.(data as SummaryEvent);
        else if (LIVE_TYPES.has(data?.type)) onLive?.(data as LiveEvent);
      } catch {
        /* ignore */
      }
    };

    if (isTauriRuntime()) {
      const connectionId = crypto.randomUUID().replace(/-/g, "");
      const unlisten = await tauriListen<string>(`backend-ws-event-${connectionId}`, handleMessage);
      await tauriInvoke<string>("backend_ws_connect", { connectionId });
      return () => {
        unlisten();
        void tauriInvoke<void>("backend_ws_disconnect", { connectionId });
      };
    }

    const cfg = await getConfig();
    const url = cfg.base_url.replace(/^http/, "ws") + "/ws";
    const protocols = cfg.token
      ? [WS_SUBPROTOCOL, `${WS_AUTH_SUBPROTOCOL_PREFIX}${cfg.token}`]
      : undefined;
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      ws = socket;
      socket.onmessage = (m) => handleMessage(m.data);
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
    await downloadBlob(`/api/recordings/${id}/audio`, `${title}.wav`);
  },
  async audioUrl(id: number, audioPath: string): Promise<string> {
    const path = `/api/recordings/${id}/audio`;
    if (isTauriRuntime()) {
      return convertLocalFileSrc(audioPath);
    }
    const cfg = await getConfig();
    if (cfg.token) throw new Error("Audio-Streaming ist im Browser mit Token nicht verfügbar");
    return `${cfg.base_url}${path}`;
  },
  getWaveform: (id: number) =>
    request<{ duration_sec: number; peaks: number[] }>(`/api/recordings/${id}/waveform`),

  // MCP (agent integration)
  getMcpInfo: () => request<McpInfo>("/api/mcp/info"),
  getMcpDiagnostics: () => request<McpDiagnostics>("/api/mcp/diagnostics"),
  registerMcp: async (targetId: string) => {
    if (!isTauriRuntime()) {
      throw new Error("Automatische MCP-Einrichtung ist nur in der Desktop-App verfügbar.");
    }
    const result = await tauriInvoke<McpRegistrationResult>("mcp_register_host", { targetId });
    try {
      await request<void>("/api/mcp/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "register", target_id: targetId }),
      });
    } catch {}
    return result;
  },
  unregisterMcp: async (targetId: string) => {
    if (!isTauriRuntime()) {
      throw new Error("MCP-Einträge können nur in der Desktop-App automatisch entfernt werden.");
    }
    const result = await tauriInvoke<McpRegistrationResult>("mcp_unregister_host", { targetId });
    try {
      await request<void>("/api/mcp/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unregister", target_id: targetId }),
      });
    } catch {}
    return result;
  },
};
