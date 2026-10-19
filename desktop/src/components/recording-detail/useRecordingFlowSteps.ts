import { jobPhaseLabel } from "../../lib/format";
import type { DiarizationData, JobEvent, SummaryTemplate, TranscriptData } from "../../lib/types";
import type { FlowStep } from "./model";

export function useRecordingFlowSteps({
  activeJob, jobs = [], running, transcript, diar, summaryCount, actionItemCount,
  pendingPhase, rangeValid, templates, templateId, onTemplateChange,
  onStartTranscription, onStartDiarization, onMatchSpeakers, onExtractActionItems, onSummarize,
}: {
  activeJob?: JobEvent;
  jobs?: JobEvent[];
  running: boolean;
  transcript?: TranscriptData;
  diar?: DiarizationData;
  summaryCount: number;
  actionItemCount: number;
  pendingPhase: string | null;
  rangeValid: boolean;
  templates: SummaryTemplate[];
  templateId: number | null;
  onTemplateChange: (id: number) => void;
  onStartTranscription: (replaceExisting: boolean) => void;
  onStartDiarization: () => void;
  onMatchSpeakers: () => void;
  onExtractActionItems: () => void;
  onSummarize: () => void;
}): FlowStep[] {
  const allJobs = activeJob ? [activeJob, ...jobs] : jobs;
  const latest = (phase: string) => allJobs.filter((job) => job.phase === phase)
    .sort((a, b) => b.job_id - a.job_id)[0];
  const asrId = latest("asr")?.job_id ?? 0;
  const diarId = latest("diarization")?.job_id ?? 0;
  const matching = latest("speaker_matching");
  const actions = latest("action_items");
  const matchingDone = matching?.status === "done" && matching.job_id > Math.max(asrId, diarId);
  const actionsDone = actions?.status === "done" && actions.job_id > asrId;
  const busy = running || pendingPhase !== null;
  const create = (key: string, phase: string, label: string, detail: string,
    done: boolean, available: boolean, onClick: () => void, optional = false): FlowStep => {
    const job = latest(phase);
    const active = pendingPhase === phase || job?.status === "running" || job?.status === "pending";
    const failed = job?.status === "failed";
    const progress = pendingPhase === phase ? 0 : Math.round((job?.progress ?? 0) * 100);
    return {
      key, eyebrow: optional ? "Optional" : "Verarbeitung", label,
      detail: active ? `${jobPhaseLabel(phase)}… ${progress}%`
        : failed ? job.error ?? "Verarbeitung fehlgeschlagen. Erneut starten."
        : detail,
      state: active ? "active" : failed ? "error" : done ? "done"
        : !available ? "waiting" : optional ? "optional" : "next",
      progress: active ? progress : null,
      action: { label: done ? "Erneut starten" : "Starten", onClick, disabled: busy || !available },
    };
  };
  const summary = create("summary", "summarize", "Zusammenfassung",
    transcript ? `${summaryCount} gespeichert · Vorlage auswählen und starten.`
      : "Nach der Transkription verfügbar.", summaryCount > 0,
    !!transcript && templateId !== null, onSummarize);
  summary.selection = {
    label: "Template für Zusammenfassung", value: templateId ?? "", disabled: busy || !transcript,
    options: templates.map((template) => ({ value: template.id, label: template.name })),
    onChange: onTemplateChange,
  };
  return [
    create("transcript", "asr", "Transkription", transcript
      ? `${transcript.words.length} Wörter · ${transcript.asr_model}`
      : "Audio zuerst prüfen und bei Bedarf kürzen.", !!transcript, rangeValid,
    () => onStartTranscription(!!transcript)),
    create("speakers", "diarization", "Diarisierung", diar
      ? `${diar.speakers.length} Sprecher · ${diar.utterances.length} Abschnitte`
      : transcript ? "Stimmen trennen; für die Auswertung nicht erforderlich."
      : "Benötigt eine abgeschlossene Transkription.", !!diar, !!transcript, onStartDiarization, true),
    create("matching", "speaker_matching", "Speaker Matching", !transcript
      ? "Benötigt eine abgeschlossene Transkription."
      : !diar ? "Benötigt Sprecher aus Diarisierung oder Transkriptionsmodell."
      : matchingDone ? "Abgleich mit gespeicherten Stimmprofilen abgeschlossen."
      : "Erkannte Stimmen mit gespeicherten Personen abgleichen.", !!matchingDone,
    !!transcript && !!diar, onMatchSpeakers, true),
    create("actions", "action_items", "Aufgaben und Entscheidungen", !transcript
      ? "Benötigt eine abgeschlossene Transkription."
      : actionsDone || actionItemCount > 0 ? `${actionItemCount} Einträge · Ergebnis im Zeitstrahl.`
      : "Aufgaben, Entscheidungen und Zusagen extrahieren; auch ohne Sprecheranalyse.",
    !!actionsDone || actionItemCount > 0, !!transcript, onExtractActionItems),
    summary,
  ];
}
