import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, HardwareInfo, ModelStatusPayload } from "../../lib/types";
import { CalendarSettingsTab } from "./CalendarSettingsTab";
import { GeneralSettingsTab } from "./GeneralSettingsTab";
import { ModelsSettingsTab } from "./ModelsSettingsTab";
import { SpeakersSettingsTab } from "./SpeakersSettingsTab";
import { SummarySettingsTab } from "./SummarySettingsTab";

vi.mock("../LlmSettings", () => ({
  LlmSettings: () => <div>LLM settings</div>,
}));

vi.mock("../../hooks/queries", () => ({
  useDeleteKnownSpeaker: () => ({ mutate: vi.fn() }),
  useKnownSpeakers: () => ({ data: [{ id: 1, name: "Valentino", color: "#0f766e", sample_count: 2 }] }),
}));

const settings: AppSettings = {
  language: "de",
  performance_profile: "balanced",
  asr_override: "parakeet-mlx",
  asr_model: "mlx-community/parakeet-tdt-0.6b-v3",
  recording_source: "microphone",
  recording_device_id: "",
  diarization_model: "pyannote/speaker-diarization-community-1",
  speaker_match_threshold: 0.5,
  live_transcription_enabled: true,
  live_speaker_detection_enabled: true,
  live_speaker_matching_enabled: true,
  my_speaker_id: 1,
  llm: { provider: "ollama", base_url: "http://localhost:11434/v1", model: "llama" },
  hf_token_set: false,
  llm_chunk_size: 48000,
  summary_use_topic_knowledge: true,
  agent_rag_enabled: false,
  agent_rag: { max_rounds: 5, max_context_tokens: 12000, top_k: 6 },
  digest_export_path: "/tmp",
  dictation_shortcut: "Alt+Meta+D",
  meeting_detection_enabled: true,
  meeting_detection_apps: ["zoom.us"],
  caldav: { url: "https://example.test/calendar", username: "user" },
  caldav_password_set: false,
  secret_storage: { available: true, secure: true, keyring_available: true, fallback_enabled: false },
};

const hardware: HardwareInfo = {
  os: "macos",
  arch: "arm64",
  is_apple_silicon: true,
  has_mps: true,
  has_cuda: false,
  cuda_device: null,
  vram_gb: null,
  memory_gb: 16,
  recommended_asr: "parakeet-mlx",
  recommended_device: "mps",
  recommended_precision: "float16",
  recommended_profile: "balanced",
  ffmpeg_available: true,
  ffprobe_available: true,
};

const modelStatus: ModelStatusPayload = {
  models_dir: "/models",
  items: [
    {
      key: "asr",
      kind: "asr",
      label: "Parakeet",
      engine: "parakeet-mlx",
      model: "mlx-community/parakeet-tdt-0.6b-v3",
      repo_id: "mlx-community/parakeet-tdt-0.6b-v3",
      downloaded: true,
      status: "downloaded",
      path: "/models/parakeet",
      active: true,
      runtime_memory_min_gb: 2,
      runtime_memory_max_gb: 3,
    },
  ],
};

function text(markup: string) {
  return markup.replace(/\s+/g, " ");
}

describe("settings tabs", () => {
  it("renders the general settings tab in isolation", () => {
    const html = renderToStaticMarkup(
      <GeneralSettingsTab
        settings={settings}
        setSettings={vi.fn()}
        recordingDevices={[{ deviceId: "mic-1", label: "Studio Mic" }]}
        systemAudioCapability={{
          supported: true,
          current_macos_version: "15.0",
          minimum_macos_version: "13.0",
          reason: null,
        }}
        autostartStatus={{ supported: true, enabled: true }}
        autostartBusy={false}
        statusEl={null}
        refreshRecordingDevices={vi.fn()}
        saveDictationShortcut={vi.fn()}
        saveMeetingDetection={vi.fn()}
        saveAutostartEnabled={vi.fn()}
      />,
    );

    expect(text(html)).toContain("Standard-Mikrofon");
    expect(text(html)).toContain("Studio Mic");
    expect(text(html)).toContain("Bei der Anmeldung starten");
    expect(text(html)).toContain("Live-Diarisierung");
    expect(text(html)).toContain("Live-Speaker-Matching");
  });

  it("renders the models settings tab in isolation", () => {
    const html = renderToStaticMarkup(
      <ModelsSettingsTab
        settings={settings}
        setSettings={vi.fn()}
        hardware={hardware}
        modelStatus={modelStatus}
        modelStatusLoading={false}
        token=""
        setToken={vi.fn()}
        busy={false}
        secretStorageWarning={null}
        selectedAsrEngine="parakeet-mlx"
        refreshModelStatus={vi.fn()}
        savePerformanceProfile={vi.fn()}
        saveAsrEngine={vi.fn()}
        saveAsrModel={vi.fn()}
        applyAsrSuggestion={vi.fn()}
        saveDiarizationModel={vi.fn()}
        applyDiarizationSuggestion={vi.fn()}
        saveToken={vi.fn()}
        removeToken={vi.fn()}
      />,
    );

    expect(text(html)).toContain("Lokale Modelle");
    expect(text(html)).toContain("Parakeet MLX");
  });

  it("renders the summary settings tab in isolation", () => {
    const html = renderToStaticMarkup(
      <SummarySettingsTab
        settings={settings}
        setSettings={vi.fn()}
        chooseDigestFolder={vi.fn()}
        onShowTemplates={vi.fn()}
      />,
    );

    expect(text(html)).toContain("LLM settings");
    expect(text(html)).toContain("Wochen-Digest Export-Ordner");
  });

  it("renders the calendar settings tab in isolation", () => {
    const html = renderToStaticMarkup(
      <CalendarSettingsTab
        settings={settings}
        setSettings={vi.fn()}
        caldavPassword=""
        setCaldavPassword={vi.fn()}
        busy={false}
        secretStorageWarning={null}
        statusEl={null}
        saveCaldav={vi.fn()}
        testCaldav={vi.fn()}
        removeCaldavPassword={vi.fn()}
      />,
    );

    expect(text(html)).toContain("CalDAV-Kalender");
    expect(text(html)).toContain("Verbindung testen");
  });

  it("renders the speakers settings tab in isolation", () => {
    const html = renderToStaticMarkup(
      <SpeakersSettingsTab settings={settings} setSettings={vi.fn()} />,
    );

    expect(text(html)).toContain("Bekannte Sprecher");
    expect(text(html)).toContain("Valentino");
  });
});
