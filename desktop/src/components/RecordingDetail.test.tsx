import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JobEvent, Recording, TranscriptData } from "../lib/types";
import { RecordingDetail } from "./RecordingDetail";

const recording: Recording = {
  id: 41, topic_id: 1, title: "Projektbesprechung", audio_path: "/audio.wav",
  original_filename: null, duration_sec: 80, sample_rate: 16000, language: "de",
  kind: "recording", status: "ready", exported_at: null, created_at: "2026-10-19",
};
const transcript = {
  transcript_id: 1, asr_model: "test", text: "Das ist das Transkript.",
  words: [{ start: 0, end: 2, text: "Das ist das Transkript.", probability: 1 }],
} as unknown as TranscriptData;

function render({ hasTranscript = true, job }: { hasTranscript?: boolean; job?: JobEvent } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["transcript", recording.id], hasTranscript ? transcript : null);
  client.setQueryData(["jobs", "recording", recording.id], job ? [job] : []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RecordingDetail recording={recording} topics={[]} onBack={vi.fn()} onOpenDocument={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("recording detail workspace", () => {
  it("keeps the transcript and playback free of processing steps and trim controls", () => {
    const html = render();
    expect(html).toContain("Das ist das Transkript.");
    expect(html).toContain('aria-label="Audiowiedergabe"');
    expect(html).toContain(">Verarbeitung</button>");
    expect(html).not.toContain('aria-label="Verarbeitungsschritte"');
    expect(html).not.toContain("Audio kürzen");
    expect(html).not.toContain("Vorlage für Zusammenfassung");
  });

  it("directs an untranscribed recording to the processing page", () => {
    const html = render({ hasTranscript: false });
    expect(html).toContain("Noch kein Transkript");
    expect(html).toContain("Zur Verarbeitung");
    expect(html).not.toContain("Jetzt transkribieren");
    expect(html).not.toContain('aria-label="Verarbeitungsschritte"');
  });

  it("keeps current work visible without restoring the workflow list", () => {
    const html = render({ job: {
      type: "job", recording_id: recording.id, job_id: 7, phase: "summarize",
      status: "running", progress: 0.4, error: null,
    } });
    expect(html).toContain("Erstelle Zusammenfassung…");
    expect(html).toContain("40 %");
    expect(html).toContain("Verarbeitung öffnen");
    expect(html).not.toContain('aria-label="Verarbeitungsschritte"');
  });

  it("shows a persisted failure when the recording is reopened", () => {
    const html = render({ job: {
      type: "job", recording_id: recording.id, job_id: 8, phase: "summarize",
      status: "failed", progress: 0, error: "Anbieter nicht erreichbar",
    } });
    expect(html).toContain("Verarbeitung fehlgeschlagen");
    expect(html).toContain("Anbieter nicht erreichbar");
    expect(html).toContain("Verarbeitung öffnen");
    expect(html).not.toContain("Erneut versuchen");
    expect(html).not.toContain('aria-label="Verarbeitungsschritte"');
  });
});
