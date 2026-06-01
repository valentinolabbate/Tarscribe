import type {
  AppSettings,
  DiarizationData,
  HardwareInfo,
  JobEvent,
  KnownSpeaker,
  LlmConfig,
  Recording,
  Summary,
  SummaryEvent,
  SummaryTemplate,
  TranscriptData,
  Topic,
} from "./types";

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

  listTopics: () => request<Topic[]>("/api/topics"),
  createTopic: (name: string, color?: string) =>
    request<Topic>("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color }),
    }),
  updateTopic: (id: number, patch: Partial<Pick<Topic, "name" | "color" | "export_path">>) =>
    request<Topic>(`/api/topics/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  sendToFolder: (id: number) =>
    request<{ path: string }>(`/api/recordings/${id}/send-to-folder`, { method: "POST" }),
  deleteTopic: (id: number) => request<void>(`/api/topics/${id}`, { method: "DELETE" }),

  listRecordings: (topicId?: number) =>
    request<Recording[]>(`/api/recordings${topicId != null ? `?topic_id=${topicId}` : ""}`),
  uploadRecording: (topicId: number, file: File, title?: string) => {
    const form = new FormData();
    form.set("topic_id", String(topicId));
    if (title) form.set("title", title);
    form.set("file", file);
    return request<Recording>("/api/recordings", { method: "POST", body: form });
  },
  updateRecording: (id: number, patch: { title?: string; topic_id?: number }) =>
    request<Recording>(`/api/recordings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteRecording: (id: number) =>
    request<void>(`/api/recordings/${id}`, { method: "DELETE" }),

  transcribe: (id: number, asr?: string) =>
    request<{ job_id: number; status: string }>(
      `/api/recordings/${id}/transcribe${asr ? `?asr=${asr}` : ""}`,
      { method: "POST" },
    ),
  getTranscript: (id: number) =>
    request<TranscriptData>(`/api/recordings/${id}/transcript`),
  getJobs: (id: number) =>
    request<JobEvent[]>(`/api/recordings/${id}/jobs`),
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
  updateSettings: (patch: Partial<Omit<AppSettings, "hf_token_set">>) =>
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

  /** Open a WebSocket for live job + summary streaming. Returns a cleanup function. */
  async connectJobs(
    onEvent: (e: JobEvent) => void,
    onSummary?: (e: SummaryEvent) => void,
  ): Promise<() => void> {
    const cfg = await getConfig();
    const url = cfg.base_url.replace(/^http/, "ws") + "/ws";
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const socket = new WebSocket(url);
      ws = socket;
      socket.onmessage = (m) => {
        try {
          const data = JSON.parse(m.data);
          if (data?.type === "job") onEvent(data as JobEvent);
          else if (data?.type === "summary") onSummary?.(data as SummaryEvent);
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
};
