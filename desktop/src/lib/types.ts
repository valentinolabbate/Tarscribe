export interface Topic {
  id: number;
  name: string;
  color: string;
  export_path: string | null;
  created_at: string;
}

export type RecordingStatus =
  | "uploaded"
  | "queued"
  | "transcribing"
  | "diarizing"
  | "ready"
  | "failed";

export interface Recording {
  id: number;
  topic_id: number;
  title: string;
  audio_path: string;
  original_filename: string | null;
  duration_sec: number;
  sample_rate: number;
  language: string | null;
  status: RecordingStatus;
  created_at: string;
}

export interface AppSettings {
  language: string | null;
  asr_override: string | null;
  recording_device_id: string;
  diarization_model: string;
  llm: { provider: string; base_url: string; model: string | null };
  hf_token_set: boolean;
}

export interface WordSeg {
  start: number;
  end: number;
  text: string;
  confidence: number | null;
}

export interface TranscriptData {
  transcript_id: number;
  asr_model: string;
  language: string | null;
  text: string;
  words: WordSeg[];
}

export interface SummaryTemplate {
  id: number;
  name: string;
  system_prompt: string;
  user_prompt_template: string;
  output_format: string;
  model_override: string | null;
  is_builtin: boolean;
}

export interface Summary {
  id: number;
  recording_id: number;
  template_id: number | null;
  model: string;
  content: string;
  created_at: string;
}

export interface LlmConfig {
  provider?: string;
  base_url?: string;
  model?: string | null;
}

export interface SummaryEvent {
  type: "summary";
  recording_id: number;
  summary_id: number;
  delta: string;
  done: boolean;
  error?: string;
}

export interface KnownSpeaker {
  id: number;
  name: string;
  color: string;
  sample_count: number;
}

export interface Utterance {
  speaker: string;
  name: string;
  start: number;
  end: number;
  text: string;
}

export interface DiarizationData {
  run_id: number;
  model: string;
  params: Record<string, number | null>;
  num_speakers: number | null;
  speakers: { label: string; name: string }[];
  utterances: Utterance[];
  segments: { speaker: string; start: number; end: number }[];
}

export interface JobEvent {
  type?: "job";
  job_id: number;
  recording_id: number;
  phase: string;
  status: "pending" | "running" | "done" | "failed" | "canceled";
  progress: number;
  error: string | null;
}

export interface HardwareInfo {
  os: string;
  arch: string;
  is_apple_silicon: boolean;
  has_mps: boolean;
  has_cuda: boolean;
  cuda_device: string | null;
  vram_gb: number | null;
  recommended_asr: string;
  recommended_device: string;
  recommended_precision: string;
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
}
