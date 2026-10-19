import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DiarizationData, JobEvent, SummaryTemplate, TranscriptData } from "../../lib/types";
import { RecordingFlowTimeline } from "./RecordingFlowTimeline";
import { useRecordingFlowSteps } from "./useRecordingFlowSteps";

function flow(overrides: Partial<Parameters<typeof useRecordingFlowSteps>[0]> = {}) {
  return useRecordingFlowSteps({
    running: false, summaryCount: 0, actionItemCount: 0, pendingPhase: null, rangeValid: true,
    templates: [{ id: 1, name: "Besprechung" }, { id: 2, name: "Interview" }] as SummaryTemplate[],
    templateId: 2, onTemplateChange: vi.fn(), onStartTranscription: vi.fn(),
    onStartDiarization: vi.fn(), onMatchSpeakers: vi.fn(), onExtractActionItems: vi.fn(),
    onSummarize: vi.fn(), ...overrides,
  });
}
const transcript = { words: [{ text: "Hallo" }], asr_model: "test" } as TranscriptData;
const diar = { speakers: [{ label: "SPEAKER_00" }], utterances: [] } as unknown as DiarizationData;

function job(phase: string, status: JobEvent["status"], job_id = 1): JobEvent {
  return { type: "job", recording_id: 1, job_id, phase, status, progress: 1, error: null };
}

describe("manual recording workflow", () => {
  it("always shows the whole list and locks followups before transcription", () => {
    const steps = flow();
    expect(steps.map((step) => step.label)).toEqual([
      "Transkription", "Diarisierung", "Speaker Matching", "Aufgaben und Entscheidungen", "Zusammenfassung",
    ]);
    expect(steps[0].action?.disabled).toBe(false);
    expect(steps.slice(1).every((step) => step.action?.disabled)).toBe(true);
    const html = renderToStaticMarkup(<RecordingFlowTimeline steps={steps} />);
    expect(html).toContain("Aufnahme-Workflow");
    expect(html).toContain("Template für Zusammenfassung");
    expect(html).toContain('<option value="2" selected="">Interview</option>');
  });

  it("allows analyses without optional diarization and requires speakers for matching", () => {
    const steps = flow({ transcript });
    expect(steps[1].action?.disabled).toBe(false);
    expect(steps[2].action?.disabled).toBe(true);
    expect(steps[3].action?.disabled).toBe(false);
    expect(steps[4].action?.disabled).toBe(false);
    expect(flow({ transcript, diar })[2].action?.disabled).toBe(false);
  });

  it("locks all steps while work is pending and rejects an invalid audio selection", () => {
    expect(flow({ transcript, diar, pendingPhase: "speaker_matching" })
      .every((step) => step.action?.disabled)).toBe(true);
    expect(flow({ rangeValid: false })[0].action?.disabled).toBe(true);
  });

  it("keeps an extraction with zero results complete and does not reuse old matching after ASR", () => {
    expect(flow({ transcript, jobs: [job("action_items", "done")] })[3].state).toBe("done");
    const steps = flow({ transcript, diar, jobs: [
      job("asr", "done", 3), job("speaker_matching", "done", 2),
    ] });
    expect(steps[2].state).toBe("optional");
  });

  it("provides the template selector and a direct summary start action", () => {
    const onTemplateChange = vi.fn();
    const onSummarize = vi.fn();
    const steps = flow({ transcript, onTemplateChange, onSummarize });
    const summary = steps[4];
    summary.selection?.onChange(1);
    summary.action?.onClick();
    expect(onTemplateChange).toHaveBeenCalledWith(1);
    expect(onSummarize).toHaveBeenCalledOnce();
    expect(flow({ transcript, templates: [], templateId: null })[4].action?.disabled).toBe(true);
  });
});
