import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LiveRecordingHandle } from "../hooks/useLiveRecording";
import { LiveRecordingDetail } from "./LiveRecordingDetail";

function liveHandle(
  speakerDetectionEnabled?: boolean,
  degraded = false,
): LiveRecordingHandle {
  return {
    sessionId: "live-1",
    receivedDurationSec: 8,
    queueLength: 0,
    hasUploadError: false,
    degraded,
    degradedReason: degraded ? "no_hf_token" : null,
    transcriptSnapshot: {
      revision: 1,
      duration_sec: 8,
      speaker_detection_enabled: speakerDetectionEnabled,
      words: [
        {
          id: "w1",
          start: 5.2,
          end: 5.7,
          text: "Hallo ",
          confidence: 0.9,
          is_final: true,
          speaker_id: "speaker-1",
        },
        {
          id: "w2",
          start: 5.7,
          end: 6.2,
          text: "Welt.",
          confidence: 0.9,
          is_final: true,
          speaker_id: "speaker-1",
        },
      ],
    },
    speakerSnapshot: {
      revision: 1,
      speakers: [
        {
          id: "speaker-1",
          display_name: "Valentino",
          known_speaker_id: 1,
          similarity: 0.91,
          match_status: "confirmed",
        },
      ],
    },
    finish: vi.fn(),
    notifyPause: vi.fn(),
    notifyResume: vi.fn(),
    cancel: vi.fn(),
    onLiveEvent: vi.fn(),
  };
}

function render(
  showLiveSpeakers: boolean,
  speakerDetectionEnabled?: boolean,
  degraded = false,
) {
  return renderToStaticMarkup(
    <LiveRecordingDetail
      topicName="Projekt"
      elapsed={0}
      state="recording"
      handle={liveHandle(speakerDetectionEnabled, degraded)}
      showLiveSpeakers={showLiveSpeakers}
      finalTranscriptionJob={null}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onStop={vi.fn()}
    />,
  );
}

describe("LiveRecordingDetail", () => {
  it("shows speaker information when live diarization is enabled", () => {
    const html = render(true);

    expect(html).toContain("Valentino");
    expect(html).not.toContain(">00:05<");
  });

  it("shows only timestamps and transcript text when live diarization is disabled", () => {
    const html = render(false);

    expect(html).toContain(">00:05<");
    expect(html).toContain("Hallo Welt.");
    expect(html).not.toContain("Valentino");
    expect(html).not.toContain("live-speaker-chip");
  });

  it("reacts when live diarization is disabled during the recording", () => {
    const html = render(true, false, true);

    expect(html).toContain(">00:05<");
    expect(html).not.toContain("Valentino");
    expect(html).not.toContain("live-speaker-chip");
    expect(html).not.toContain("Kein HF-Token");
  });
});
