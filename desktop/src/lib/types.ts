export interface Topic {
  id: number;
  name: string;
  color: string;
  export_path: string | null;
  calendar_export_mode: "off" | "approval" | "auto";
  calendar_url: string | null;
  position: number;
  created_at: string;
  recording_count: number;
  transcribed_count: number;
  diarized_count: number;
  exported_count: number;
}

export type DocumentStatus = "uploaded" | "indexing" | "ready" | "failed";

export interface TopicDocument {
  id: number;
  topic_id: number;
  /** Null for topic-level documents; set when attached to one recording. */
  recording_id: number | null;
  title: string;
  original_filename: string | null;
  content_type: string | null;
  text_chars: number;
  status: DocumentStatus;
  error: string | null;
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
  kind: "recording" | "dictation" | string;
  status: RecordingStatus;
  exported_at: string | null;
  created_at: string;
}

export type RecordingSource = "microphone" | "system_audio" | "system_audio_and_microphone";
export type PerformanceProfile = "m1_8gb" | "balanced" | "quality";

export interface AppSettings {
  language: string | null;
  performance_profile: PerformanceProfile;
  asr_override: string | null;
  recording_source: RecordingSource;
  recording_device_id: string;
  diarization_model: string;
  speaker_match_threshold: number;
  /** Known-speaker id treated as "me" for the Tasks area. 0/null = unset. */
  my_speaker_id: number | null;
  llm: { provider: string; base_url: string; model: string | null };
  hf_token_set: boolean;
  llm_chunk_size: number;
  summary_use_topic_knowledge: boolean;
  digest_export_path: string;
  dictation_shortcut: string;
  meeting_detection_enabled: boolean;
  meeting_detection_apps: string[];
  caldav: { url: string; username: string };
  caldav_password_set: boolean;
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

export interface SummarySource {
  index: number;
  recording_id: number | null;
  recording_title: string | null;
  document_id?: number | null;
  source_type: RagSourceType;
}

export interface Summary {
  id: number;
  recording_id: number;
  template_id: number | null;
  model: string;
  content: string;
  /** JSON-encoded SummarySource[] of topic knowledge woven into the summary. */
  sources: string | null;
  created_at: string;
}

export interface Digest {
  id: number;
  date_from: string;
  date_to: string;
  content_markdown: string;
  model: string;
  recording_count: number;
  created_at: string;
}

export interface ThreadMention {
  id: number;
  thread_id: number;
  recording_id: number;
  recording_title: string | null;
  topic_id: number | null;
  topic_name: string | null;
  topic_color: string | null;
  start_sec: number | null;
  text: string;
  created_at: string;
  recording_created_at: string | null;
}

export interface TopicThread {
  id: number;
  title: string;
  updated_at: string;
  created_at: string;
  mention_count: number;
  recording_count: number;
  mentions: ThreadMention[];
}

export interface DictationResult {
  recording: Recording;
  job_id: number;
  topic_id: number;
  topic_name: string;
}

export interface LlmConfig {
  provider?: string;
  base_url?: string;
  model?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  max_tokens?: number | null;
  /** Reasoning/"thinking" depth for capable models: minimal|low|medium|high. */
  reasoning_effort?: string | null;
  /** Read-only: whether a (secret) API key is stored in the keychain. */
  api_key_set?: boolean;
}

export interface McpHostTarget {
  id: string;
  label: string;
  fmt: string;
  path: string;
  present: boolean;
  registered: boolean;
}

export interface McpInfo {
  module: string;
  command: string;
  args: string[];
  connection_file: string;
  snippet: string;
  targets: McpHostTarget[];
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

export interface DebugJob extends JobEvent {
  recording_title: string | null;
  topic_id: number | null;
  topic_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface HardwareInfo {
  os: string;
  arch: string;
  is_apple_silicon: boolean;
  has_mps: boolean;
  has_cuda: boolean;
  cuda_device: string | null;
  vram_gb: number | null;
  memory_gb: number | null;
  recommended_asr: string;
  recommended_device: string;
  recommended_precision: string;
  recommended_profile: PerformanceProfile;
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
}

export type LiveSessionStatus =
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed"
  | "canceled";

export interface LiveSession {
  id: string;
  topic_id: number;
  title: string;
  status: LiveSessionStatus;
  sample_rate: number;
  channels: number;
  last_sequence_number: number;
  received_duration_sec: number;
  transcript_snapshot_json: string | null;
  speaker_snapshot_json: string | null;
  last_analyzed_sec: number;
  finalized_recording_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveWord {
  id: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
  is_final: boolean;
  speaker_id: string | null;
}

export interface LiveTranscriptSnapshot {
  revision: number;
  duration_sec: number;
  words: LiveWord[];
}

export interface LiveSpeaker {
  id: string;
  display_name: string;
  known_speaker_id: number | null;
  similarity: number | null;
  match_status: "none" | "probable" | "confirmed";
}

export interface LiveSpeakerSnapshot {
  revision: number;
  speakers: LiveSpeaker[];
}

export interface LiveSessionEvent {
  type: "live_session";
  session_id: string;
  status: LiveSessionStatus;
  received_duration_sec?: number;
}

export interface LiveTranscriptEvent {
  type: "live_transcript";
  session_id: string;
  snapshot: LiveTranscriptSnapshot;
}

export interface LiveSpeakersEvent {
  type: "live_speakers";
  session_id: string;
  snapshot: LiveSpeakerSnapshot;
}

export interface LiveFinalizedEvent {
  type: "live_finalized";
  session_id: string;
  recording_id: number | null;
}

export interface LiveDegradedEvent {
  type: "live_degraded";
  session_id: string;
  reason: string;
}

export type LiveEvent =
  | LiveSessionEvent
  | LiveTranscriptEvent
  | LiveSpeakersEvent
  | LiveFinalizedEvent
  | LiveDegradedEvent;

// ── RAG / Wissens-Chat ──────────────────────────────────────────────────
export interface RagConfig {
  base_url?: string;
  model?: string;
  dimension?: number;
  top_k?: number;
  enabled?: boolean;
  /** Read-only: whether a (secret) embedding API key is stored in the keychain. */
  api_key_set?: boolean;
  /** Read-only: whether the sqlite-vec extension loaded successfully. */
  vec_available?: boolean;
}

export interface RagStatus {
  vec_available: boolean;
  chunks: number;
  recordings_indexed: number;
  model?: string;
  dimension?: number;
}

export type RagSourceType = "transcript" | "summary" | "document";

export interface RagSource {
  index: number;
  /** Null for topic-level document sources (no parent recording). */
  recording_id: number | null;
  recording_title: string;
  /** Set when the source is an uploaded document. */
  document_id?: number | null;
  source_type: RagSourceType;
  start_sec?: number | null;
  end_sec?: number | null;
  speaker?: string | null;
  /** The retrieved passage text, shown inline when a source chip is clicked. */
  text?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface RagHit {
  chunk_id: number;
  recording_id: number | null;
  recording_title: string;
  topic_id: number;
  document_id?: number | null;
  source_type: RagSourceType;
  text: string;
  start_sec?: number | null;
  end_sec?: number | null;
  speaker?: string | null;
  /** Vector distance; null when the hit came only from the keyword index. */
  distance?: number | null;
  /** Hybrid (RRF) relevance score. */
  score?: number;
}

// ── Insights: Action-Items, Kapitel, Sprecher-Statistiken ───────────────
export interface ActionItem {
  id: number;
  recording_id: number;
  kind: "task" | "decision";
  text: string;
  assignee: string | null;
  due: string | null;
  due_date: string | null;
  done: boolean;
  /** Assigned to the configured "me" speaker (computed server-side). */
  is_mine: boolean;
  /** Explicitly pinned into the global Tasks area despite not being "mine". */
  include_in_tasks: boolean;
  calendar_status: "idle" | "pending_approval" | "synced" | "skipped" | "failed" | "not_configured";
  calendar_error: string | null;
  calendar_exported_at: string | null;
  created_at: string;
  recording_title: string | null;
  topic_id: number | null;
  topic_name: string | null;
  topic_color: string | null;
}

export interface Chapter {
  id: number;
  recording_id: number;
  idx: number;
  start: number;
  end: number | null;
  title: string;
}

export interface SpeakerStat {
  label: string;
  name: string;
  talk_sec: number;
  share: number;
  segments: number;
  longest_sec: number;
  interruptions_made: number;
  interruptions_received: number;
  timeline: number[];
}

export interface SpeakerStats {
  recording_id: number;
  duration_sec: number;
  total_talk_sec: number;
  bucket_sec: number;
  num_buckets: number;
  speakers: SpeakerStat[];
}
