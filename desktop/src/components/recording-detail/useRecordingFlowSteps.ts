import { fmtDuration, jobPhaseLabel } from "../../lib/format";
import type { DiarizationData, JobEvent, Recording, TranscriptData } from "../../lib/types";
import type { FlowStep } from "./model";

export function useRecordingFlowSteps({
  recording,
  activeJob,
  startingPhase,
  transcribePending,
  diarizePending,
  running,
  transcript,
  diar,
  summaryCount,
  onStartTranscription,
  onStartDiarization,
  onOpenSummary,
}: {
  recording: Recording;
  activeJob?: JobEvent;
  startingPhase: string | null;
  transcribePending: boolean;
  diarizePending: boolean;
  running: boolean;
  transcript?: TranscriptData;
  diar?: DiarizationData;
  summaryCount: number;
  onStartTranscription: (replaceExisting: boolean) => void;
  onStartDiarization: () => void;
  onOpenSummary: () => void;
}): FlowStep[] {
  const pct = Math.round((activeJob?.progress ?? 0) * 100);
  const phaseLabel = activeJob
    ? jobPhaseLabel(activeJob.phase)
    : recording.status === "diarizing"
      ? jobPhaseLabel("diarization")
      : jobPhaseLabel("asr");
  const currentPhase = startingPhase
    ? transcribePending
      ? "asr"
      : "diarization"
    : running
      ? activeJob?.phase ?? (recording.status === "diarizing" ? "diarization" : "asr")
      : null;
  const activeProgress = startingPhase ? 0 : pct;
  const asrActive = currentPhase === "asr" && (running || !!startingPhase);
  const diarActive = currentPhase === "diarization" && (running || !!startingPhase);
  const analysisActive =
    !!currentPhase && ["summarize", "action_items", "chapters", "embedding"].includes(currentPhase);
  const currentPhaseLabel =
    currentPhase === "asr"
      ? jobPhaseLabel("asr")
      : currentPhase === "diarization"
        ? jobPhaseLabel("diarization")
        : activeJob
          ? jobPhaseLabel(activeJob.phase)
          : phaseLabel;
  const asrFailed = activeJob?.status === "failed" && activeJob.phase === "asr";
  const diarFailed = activeJob?.status === "failed" && activeJob.phase === "diarization";

  return [
    {
      key: "audio",
      eyebrow: "Audio",
      label: "Aufnahme gespeichert",
      detail: `${fmtDuration(recording.duration_sec)} Audio im lokalen Archiv.`,
      state: "done",
    },
    {
      key: "transcript",
      eyebrow: "Transkript",
      label: asrFailed ? "Transkription prüfen" : asrActive ? "Transkription läuft" : "Text erstellen",
      detail: asrFailed
        ? activeJob.error ?? "Der letzte Transkriptionslauf ist fehlgeschlagen."
        : asrActive
          ? `${currentPhaseLabel}... ${activeProgress}%`
          : transcript
            ? `${transcript.words.length} Wörter · ${transcript.asr_model}`
            : "Noch kein Transkript vorhanden.",
      state: asrFailed ? "error" : asrActive ? "active" : transcript ? "done" : "next",
      progress: asrActive ? activeProgress : null,
      action:
        !transcript || asrFailed
          ? {
              label: asrFailed ? "Nochmal" : "Starten",
              onClick: () => onStartTranscription(!!transcript),
              disabled: transcribePending || running,
            }
          : undefined,
    },
    {
      key: "speakers",
      eyebrow: "Sprecher",
      label: diarFailed ? "Sprecherlauf prüfen" : diarActive ? "Sprechererkennung läuft" : "Stimmen zuordnen",
      detail: diarFailed
        ? activeJob.error ?? "Die Diarisierung ist fehlgeschlagen."
        : diarActive
          ? `${currentPhaseLabel}... ${activeProgress}%`
          : diar
            ? `${diar.speakers.length} Sprecher · ${diar.utterances.length} Abschnitte`
            : transcript
              ? "Optional, wenn mehrere Stimmen enthalten sind."
              : "Nach der Transkription verfügbar.",
      state: diarFailed ? "error" : diarActive ? "active" : diar ? "done" : transcript ? "optional" : "waiting",
      progress: diarActive ? activeProgress : null,
      action:
        transcript && !diar
          ? {
              label: diarFailed ? "Nochmal" : "Erkennen",
              onClick: onStartDiarization,
              disabled: diarizePending || running,
            }
          : undefined,
    },
    {
      key: "analysis",
      eyebrow: "Auswertung",
      label: analysisActive ? "Auswertung läuft" : "Zusammenfassen",
      detail: analysisActive
        ? `${currentPhaseLabel}... ${activeProgress}%`
        : summaryCount > 0
          ? `${summaryCount} gespeicherte Zusammenfassung${summaryCount === 1 ? "" : "en"}`
          : transcript
            ? "Aufgabenstatus prüfen, dann zusammenfassen."
            : "Nach dem Transkript verfügbar.",
      state: analysisActive ? "active" : summaryCount > 0 ? "done" : transcript ? "next" : "waiting",
      progress: analysisActive ? activeProgress : null,
      action:
        transcript && !analysisActive
          ? {
              label: summaryCount > 0 ? "Öffnen" : "Erstellen",
              onClick: onOpenSummary,
            }
          : undefined,
    },
  ];
}
