import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AudioPlayer, type PlayerHandle } from "./AudioPlayer";
import {
  useDiarization,
  useDiarize,
  useEnrollSpeaker,
  useSpeakerEdits,
  useLatestJob,
  useRetryJob,
  useSummaries,
  useTranscribe,
  useTranscript,
  useUpdateRecording,
} from "../hooks/queries";
import { preferJobEvent, useJobFor } from "../hooks/useJobs";
import { api } from "../lib/api";
import { fmtDuration, jobPhaseLabel, statusLabel } from "../lib/format";
import type { DiarizationData, Recording, Topic, WordSeg } from "../lib/types";
import { useToast } from "./Toast";
import { ChatIcon, FolderIcon, SpeakerIdIcon, SummaryIcon, WaveIcon } from "./icons";
import { ActionItemsPanel } from "./ActionItemsPanel";
import { ChaptersBar } from "./ChaptersBar";
import { ChatPanel } from "./ChatPanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { SpeakerStatsPanel } from "./SpeakerStatsPanel";
import { SummaryPanel } from "./SummaryPanel";
import { TuningPanel } from "./TuningPanel";

const SPEAKER_COLORS = [
  "#0f766e", "#2563eb", "#b45309", "#be185d",
  "#0891b2", "#7c3aed", "#dc2626", "#4d7c0f",
];
const colorFor = (label: string, all: string[]) =>
  SPEAKER_COLORS[Math.max(0, all.indexOf(label)) % SPEAKER_COLORS.length];

const ts = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

interface Sentence {
  start: number;
  end: number;
  text: string;
}

/**
 * Group word-level timestamps into sentence-sized, seekable segments. Used for
 * the transcript view when there is no diarization (e.g. a single speaker),
 * where the backend would otherwise be shown as one giant text block.
 *
 * A segment ends at sentence-final punctuation; as fallbacks for ASR output
 * without punctuation it also breaks on a noticeable pause and at a hard word
 * cap, so the result is always readable and navigable.
 */
function groupWordsIntoSentences(words: WordSeg[]): Sentence[] {
  const sentences: Sentence[] = [];
  let current: WordSeg[] = [];
  const flush = () => {
    if (!current.length) return;
    // Word texts carry their own leading spaces (backend joins them with ""),
    // so concatenating reproduces the original spacing exactly.
    const text = current.map((w) => w.text).join("").trim();
    if (text) {
      sentences.push({ start: current[0].start, end: current[current.length - 1].end, text });
    }
    current = [];
  };
  const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/;
  const PAUSE_SEC = 0.8; // silence that likely marks a sentence boundary
  const MAX_WORDS = 45; // hard cap so unpunctuated speech still breaks up
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);
    const trimmed = word.text.trim();
    const next = words[i + 1];
    const gap = next ? next.start - word.end : Infinity;
    if (
      (trimmed && ENDS_SENTENCE.test(trimmed)) ||
      (current.length >= 4 && gap >= PAUSE_SEC) ||
      current.length >= MAX_WORDS
    ) {
      flush();
    }
  }
  flush();
  return sentences;
}

type DetailTab = "transcript" | "summary" | "ask" | "speakers";

function SpeakerLegend({
  recordingId,
  diar,
  labels,
}: {
  recordingId: number;
  diar: DiarizationData;
  labels: string[];
}) {
  const { rename, merge, reset } = useSpeakerEdits(recordingId);
  const enroll = useEnrollSpeaker(recordingId);

  function saveVoice(label: string, currentName: string) {
    const isRaw = /^SPEAKER_\d+$/.test(currentName);
    const name = isRaw
      ? window.prompt("Name für diese Stimme:", "")?.trim()
      : currentName;
    if (name) enroll.mutate({ label, name });
  }

  return (
    <div className="legend">
      {diar.speakers.map((sp) => (
        <div className="legend-item" key={sp.label}>
          <span className="topic-dot" style={{ background: colorFor(sp.label, labels) }} />
          <input
            className="legend-name"
            defaultValue={sp.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== sp.name) rename.mutate({ label: sp.label, name: v });
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <button
            className="btn ghost"
            style={{ padding: 5 }}
            title="Stimme als bekannten Sprecher speichern"
            disabled={enroll.isPending}
            onClick={() => saveVoice(sp.label, sp.name)}
          >
            <SpeakerIdIcon width={16} height={16} />
          </button>
          {diar.speakers.length > 1 && (
            <select
              className="merge-sel"
              value=""
              onChange={(e) => {
                if (e.target.value) merge.mutate({ from: sp.label, to: e.target.value });
              }}
              title="Mit anderem Sprecher zusammenführen"
            >
              <option value="">zusammenführen...</option>
              {diar.speakers
                .filter((o) => o.label !== sp.label)
                .map((o) => (
                  <option key={o.label} value={o.label}>
                    → {o.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <button className="btn ghost" onClick={() => reset.mutate()} title="Alle Korrekturen zurücksetzen">
        Zurücksetzen
      </button>
    </div>
  );
}

function DetailTabButton({
  id,
  activeTab,
  label,
  meta,
  onSelect,
}: {
  id: DetailTab;
  activeTab: DetailTab;
  label: string;
  meta: string;
  onSelect: (tab: DetailTab) => void;
}) {
  return (
    <button
      className={`detail-tab ${activeTab === id ? "active" : ""}`}
      onClick={() => onSelect(id)}
      type="button"
    >
      <span>{label}</span>
      <small>{meta}</small>
    </button>
  );
}

function DetailEmptyState({
  running,
  startingPhase,
  transcribePending,
  error,
  onTranscribe,
}: {
  running: boolean;
  startingPhase: string | null;
  transcribePending: boolean;
  error?: string | null;
  onTranscribe: () => void;
}) {
  if (running || startingPhase) return null;
  return (
    <div className="detail-empty-state">
      <div className="rec-icon"><WaveIcon /></div>
      <div>
        <h2>{error ? "Transkription fehlgeschlagen" : "Bereit zum Transkribieren"}</h2>
        <p>Erstelle zuerst ein Transkript. Danach erscheinen Zusammenfassung, Fragen und Sprecherbereiche als eigene Tabs.</p>
      </div>
      <button className="btn primary" disabled={transcribePending} onClick={onTranscribe}>
        {error ? "Erneut transkribieren" : "Jetzt transkribieren"}
      </button>
      {error && <div className="detail-error">{error}</div>}
    </div>
  );
}

type FlowStepState = "done" | "active" | "next" | "waiting" | "optional" | "error";

interface FlowStep {
  key: string;
  label: string;
  eyebrow: string;
  detail: string;
  state: FlowStepState;
  progress?: number | null;
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

function RecordingFlowTimeline({ steps }: { steps: FlowStep[] }) {
  return (
    <section className="recording-flow" aria-label="Aufnahme-Workflow">
      {steps.map((step, index) => (
        <article
          className={`recording-flow-step ${step.state}`}
          key={step.key}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <div className="recording-flow-marker" aria-hidden="true">
            <span>{index + 1}</span>
          </div>
          <div className="recording-flow-copy">
            <span className="recording-flow-kicker">{step.eyebrow}</span>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
            {step.progress != null && (
              <div className="recording-flow-progress" aria-hidden="true">
                <span style={{ width: `${step.progress}%` }} />
              </div>
            )}
          </div>
          {step.action && (
            <button
              className={step.state === "next" || step.state === "error" ? "btn primary" : "btn ghost"}
              disabled={step.action.disabled}
              onClick={step.action.onClick}
              type="button"
            >
              {step.action.label}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}

export function RecordingDetail({
  recording,
  topics,
  onBack,
  onMoved,
  onOpenSettings,
}: {
  recording: Recording;
  topics: Topic[];
  onBack: () => void;
  onMoved?: (recording: Recording) => void;
  onOpenSettings?: () => void;
}) {
  const job = useJobFor(recording.id);
  const transcribe = useTranscribe();
  const diarizeFirst = useDiarize();
  const retry = useRetryJob(recording.id);
  const { reassign } = useSpeakerEdits(recording.id);
  const updateRec = useUpdateRecording();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isFullyReady = recording.status === "ready";
  const isTranscribed = isFullyReady || recording.status === "diarizing";
  const statusRunning = recording.status === "transcribing" || recording.status === "diarizing";

  const { data: transcript, isLoading: transcriptLoading } = useTranscript(recording.id, isTranscribed);
  const { data: diar } = useDiarization(recording.id, isTranscribed && !!transcript);
  const { data: summaries } = useSummaries(recording.id, isTranscribed && !!transcript);
  // A recording can read "ready" while its transcript is missing (e.g. a finalized
  // live session that never persisted one). Treat "no transcript" as needing
  // transcription so the page never renders blank without a way to (re)transcribe.
  const transcriptPending = isTranscribed && transcriptLoading;

  const [showTuning, setShowTuning] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("transcript");
  const [exportOpen, setExportOpen] = useState(false);
  const playerRef = useRef<PlayerHandle>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);

  // Without diarization, split the single-block transcript into seekable sentences.
  const sentences = useMemo(
    () => (transcript && !diar ? groupWordsIntoSentences(transcript.words) : []),
    [transcript, diar],
  );

  const activeStart =
    (diar
      ? diar.utterances.find((u) => currentTime >= u.start && currentTime < u.end)
      : sentences.find((s) => currentTime >= s.start && currentTime < s.end)
    )?.start ?? -1;
  useEffect(() => {
    if (activeTab === "transcript" && playing && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeStart, activeTab, playing]);

  const localRunning = job?.status === "running" || job?.status === "pending";
  const { data: polledJob } = useLatestJob(recording.id, localRunning || statusRunning);
  const activeJob = preferJobEvent(job, polledJob);
  const running =
    activeJob?.status === "running" || activeJob?.status === "pending" || statusRunning;

  const startingPhase = transcribe.isPending
    ? "Starte Transkription"
    : diarizeFirst.isPending
      ? "Starte Sprechererkennung"
      : null;
  const pct = Math.round((activeJob?.progress ?? 0) * 100);
  const phaseLabel = activeJob
    ? jobPhaseLabel(activeJob.phase)
    : recording.status === "diarizing"
      ? jobPhaseLabel("diarization")
      : jobPhaseLabel("asr");
  const labels = diar?.speakers.map((s) => s.label) ?? [];
  const summaryCount = summaries?.filter((summary) => summary.content).length ?? 0;
  const transcriptMeta = diar
    ? `${diar.utterances.length} Abschnitte`
    : transcript
      ? `${sentences.length} Abschnitte · ${transcript.words.length} Wörter`
      : "Noch nicht erstellt";

  const tabs = useMemo(
    () => [
      { id: "transcript" as const, label: "Transkript", meta: transcriptMeta },
      {
        id: "summary" as const,
        label: "Zusammenfassung",
        meta: summaryCount > 0 ? `${summaryCount} gespeichert` : "Erstellen",
      },
      { id: "ask" as const, label: "Fragen", meta: "Suche & Chat" },
      {
        id: "speakers" as const,
        label: "Sprecher",
        meta: diar ? `${diar.speakers.length} erkannt` : "Optional",
      },
    ],
    [diar, summaryCount, transcriptMeta],
  );

  async function exportRecording(format: string) {
    setExportOpen(false);
    try {
      await api.downloadExport(recording.id, format, recording.title);
      await queryClient.invalidateQueries({ queryKey: ["topics"] });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function moveRecording(topicId: number) {
    if (topicId === recording.topic_id) return;
    const target = topics.find((topic) => topic.id === topicId);
    try {
      const updated = await updateRec.mutateAsync({
        id: recording.id,
        patch: { topic_id: topicId },
      });
      toast(`Verschoben nach ${target?.name ?? "neuen Bereich"}`, "success");
      onMoved?.(updated);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function startTranscription(replaceExisting: boolean) {
    if (
      replaceExisting &&
      transcript &&
      !window.confirm("Transkript nochmal neu erstellen? Das aktuelle Transkript wird ersetzt.")
    ) {
      return;
    }
    setActiveTab("transcript");
    try {
      await transcribe.mutateAsync({ id: recording.id });
      toast(replaceExisting ? "Transkription neu gestartet" : "Transkription gestartet", "info");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const currentPhase = startingPhase
    ? transcribe.isPending
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

  const flowSteps: FlowStep[] = [
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
              onClick: () => void startTranscription(!!transcript),
              disabled: transcribe.isPending || !!running,
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
              onClick: () => {
                setActiveTab("speakers");
                diarizeFirst.mutate({ id: recording.id });
              },
              disabled: diarizeFirst.isPending || !!running,
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
            ? "Zusammenfassung und Aufgaben sind bereit zum Erstellen."
            : "Nach dem Transkript verfügbar.",
      state: analysisActive ? "active" : summaryCount > 0 ? "done" : transcript ? "next" : "waiting",
      progress: analysisActive ? activeProgress : null,
      action:
        transcript && !analysisActive
          ? {
              label: summaryCount > 0 ? "Öffnen" : "Erstellen",
              onClick: () => setActiveTab("summary"),
            }
          : undefined,
    },
  ];

  return (
    <div className="detail">
      <header className="detail-hero">
        <button className="btn ghost detail-back" onClick={onBack}>← Aufnahmen</button>
        <div className="detail-title-block">
          <input
            className="detail-title-input"
            defaultValue={recording.title}
            key={recording.id}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== recording.title) updateRec.mutate({ id: recording.id, patch: { title: v } });
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            title="Zum Umbenennen klicken"
          />
          <div className="detail-meta">
            <span>{fmtDuration(recording.duration_sec)}</span>
            <span>{statusLabel(recording.status)}</span>
            {transcript && <span>{transcript.asr_model}</span>}
            {diar && <span>{diar.speakers.length} Sprecher</span>}
          </div>
        </div>

        <div className="detail-actions">
          {topics.length > 1 && (
            <label className="recording-topic-select" title="Aufnahme in einen anderen Themenbereich verschieben">
              <FolderIcon width={16} height={16} />
              <select
                value={recording.topic_id}
                disabled={updateRec.isPending}
                onChange={(e) => void moveRecording(Number(e.target.value))}
                aria-label="Aufnahme verschieben"
              >
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isTranscribed && transcript && !diar && (
            <button
              className="btn"
              disabled={diarizeFirst.isPending || running}
              onClick={() => {
                setActiveTab("speakers");
                diarizeFirst.mutate({ id: recording.id });
              }}
            >
              <SpeakerIdIcon width={16} height={16} /> Sprecher erkennen
            </button>
          )}
          {transcript && (
            <button
              className="btn ghost"
              disabled={transcribe.isPending || running}
              onClick={() => void startTranscription(true)}
              title="Transkript mit der fertigen Audiodatei neu erstellen"
            >
              Neu transkribieren
            </button>
          )}
          {isTranscribed && transcript && (
            <div className="export-wrap">
              <button className="btn ghost" onClick={() => setExportOpen((v) => !v)}>Export ▾</button>
              {exportOpen && (
                <div className="export-menu" onMouseLeave={() => setExportOpen(false)}>
                  {["txt", "srt", "vtt", "json"].map((format) => (
                    <button key={format} onClick={() => exportRecording(format)}>
                      .{format.toUpperCase()}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      api.downloadAudio(recording.id, recording.title);
                      setExportOpen(false);
                    }}
                  >
                    Audio (WAV)
                  </button>
                  <button
                    className="export-folder-item"
                    onClick={async () => {
                      setExportOpen(false);
                      try {
                        const res = await api.sendToFolder(recording.id);
                        toast(`Gesendet: ${res.path}`, "success");
                        await queryClient.invalidateQueries({ queryKey: ["topics"] });
                      } catch (e) {
                        toast((e as Error).message, "error");
                      }
                    }}
                  >
                    An Ordner senden
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <RecordingFlowTimeline steps={flowSteps} />

      {activeJob?.status === "failed" && activeJob.phase === "diarization" && (
        <div className="detail-error detail-error-box detail-error-row">
          <span>Diarisierung fehlgeschlagen: {activeJob.error}</span>
          <button
            className="btn"
            disabled={retry.isPending || running}
            onClick={() => retry.mutate(activeJob.job_id)}
          >
            {retry.isPending ? "Starte…" : "Erneut versuchen"}
          </button>
        </div>
      )}

      {activeJob?.status === "failed" && activeJob.phase === "asr" && transcript && (
        <div className="detail-error detail-error-box detail-error-row">
          <span>Transkription fehlgeschlagen: {activeJob.error}</span>
          <button
            className="btn"
            disabled={transcribe.isPending || running}
            onClick={() => void startTranscription(true)}
          >
            {transcribe.isPending ? "Starte…" : "Nochmal transkribieren"}
          </button>
        </div>
      )}

      {!transcript && !transcriptPending && (
        <DetailEmptyState
          running={!!running}
          startingPhase={startingPhase}
          transcribePending={transcribe.isPending}
          error={activeJob?.status === "failed" ? activeJob.error : null}
          onTranscribe={() => void startTranscription(false)}
        />
      )}

      {transcript && (
        <>
          <AudioPlayer
            ref={playerRef}
            recordingId={recording.id}
            onTime={setCurrentTime}
            onPlaying={setPlaying}
          />

          <ChaptersBar
            recordingId={recording.id}
            recordingTitle={recording.title}
            durationSec={recording.duration_sec}
            currentTime={currentTime}
            onSeek={(sec) => playerRef.current?.seek(sec)}
          />

          <nav className="detail-tabs" aria-label="Bereiche der Aufnahme">
            {tabs.map((tab) => (
              <DetailTabButton
                key={tab.id}
                id={tab.id}
                activeTab={activeTab}
                label={tab.label}
                meta={tab.meta}
                onSelect={setActiveTab}
              />
            ))}
          </nav>

          <div className="detail-workspace">
            {activeTab === "transcript" && (
              <section className="detail-panel transcript-workspace">
                <div className="detail-panel-head">
                  <div>
                    <h2>Transkript</h2>
                    <p>{transcriptMeta} · Klick auf einen Abschnitt springt im Audio dorthin.</p>
                  </div>
                  {diar && (
                    <button className="btn ghost" onClick={() => setActiveTab("speakers")}>
                      Sprecher bearbeiten
                    </button>
                  )}
                </div>

                {diar ? (
                  <div className="transcript transcript-focused">
                    {diar.utterances.map((u, i) => {
                      const active = currentTime >= u.start && currentTime < u.end;
                      return (
                        <div
                          className={`utterance ${active ? "active" : ""}`}
                          key={i}
                          ref={active ? activeRef : undefined}
                        >
                          <div className="utt-head">
                            <select
                              className="speaker-chip-sel"
                              style={{ background: colorFor(u.speaker, labels) }}
                              value={u.speaker}
                              onChange={(e) => {
                                if (e.target.value !== u.speaker)
                                  reassign.mutate({ start: u.start, end: u.end, speaker: e.target.value });
                              }}
                              title="Diesen Abschnitt einem Sprecher zuweisen"
                            >
                              {diar.speakers.map((s) => (
                                <option key={s.label} value={s.label}>{s.name}</option>
                              ))}
                            </select>
                            <button className="utt-time" onClick={() => playerRef.current?.seek(u.start)} title="Abspielen ab hier">
                              ▶ {ts(u.start)}
                            </button>
                          </div>
                          <p className="utt-text" onClick={() => playerRef.current?.seek(u.start)}>
                            {u.text}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                ) : sentences.length > 0 ? (
                  <div className="transcript transcript-focused">
                    {sentences.map((s, i) => {
                      const active = currentTime >= s.start && currentTime < s.end;
                      return (
                        <div
                          className={`utterance plain ${active ? "active" : ""}`}
                          key={i}
                          ref={active ? activeRef : undefined}
                        >
                          <div className="utt-head">
                            <button
                              className="utt-time"
                              onClick={() => playerRef.current?.seek(s.start)}
                              title="Abspielen ab hier"
                            >
                              ▶ {ts(s.start)}
                            </button>
                          </div>
                          <p className="utt-text" onClick={() => playerRef.current?.seek(s.start)}>
                            {s.text}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="transcript transcript-focused">
                    <p className="transcript-text">{transcript.text}</p>
                  </div>
                )}
              </section>
            )}

            {activeTab === "summary" && (
              <section className="detail-panel summary-workspace">
                <div className="detail-panel-head">
                  <div>
                    <h2>Zusammenfassung</h2>
                    <p>Erstelle oder verwalte KI-Zusammenfassungen getrennt vom Transkript.</p>
                  </div>
                  <SummaryIcon width={20} height={20} />
                </div>
                <SummaryPanel recordingId={recording.id} onOpenSettings={onOpenSettings} />
                <ActionItemsPanel recordingId={recording.id} />
              </section>
            )}

            {activeTab === "ask" && (
              <section className="detail-panel ask-workspace">
                <div className="detail-panel-head">
                  <div>
                    <h2>Chat & Suche</h2>
                    <p>Stelle Fragen direkt an diese Aufnahme oder finde Belegstellen im Transkript.</p>
                  </div>
                  <ChatIcon width={20} height={20} />
                </div>
                <ChatPanel
                  embedded
                  topics={topics}
                  scopeRecording={{ id: recording.id, title: recording.title }}
                  onOpenSource={(rec, start) => {
                    if (rec === recording.id) playerRef.current?.seek(start ?? 0);
                  }}
                />
                <DocumentsPanel compact topicId={recording.topic_id} recordingId={recording.id} />
              </section>
            )}

            {activeTab === "speakers" && (
              <section className="detail-panel speakers-workspace">
                <div className="detail-panel-head">
                  <div>
                    <h2>Sprecher</h2>
                    <p>Namen korrigieren, Stimmen speichern und die Diarisierung feinjustieren.</p>
                  </div>
                  {diar && (
                    <button className={showTuning ? "btn active" : "btn"} onClick={() => setShowTuning((v) => !v)}>
                      Tuning
                    </button>
                  )}
                </div>

                {diar ? (
                  <>
                    <SpeakerLegend recordingId={recording.id} diar={diar} labels={labels} />
                    {showTuning && (
                      <TuningPanel recordingId={recording.id} initial={diar.params} disabled={!!running} />
                    )}
                    <SpeakerStatsPanel
                      recordingId={recording.id}
                      labels={labels}
                      colorFor={(label) => colorFor(label, labels)}
                    />
                    <div className="speaker-note">
                      Sprecherzuweisung einzelner Textstellen änderst du direkt im Tab „Transkript".
                    </div>
                  </>
                ) : (
                  <div className="speaker-empty">
                    <div className="rec-icon"><SpeakerIdIcon /></div>
                    <div>
                      <h3>Noch keine Sprechererkennung</h3>
                      <p>Starte die Erkennung, wenn diese Aufnahme mehrere Stimmen enthält oder du bekannte Stimmen speichern willst.</p>
                    </div>
                    <button
                      className="btn primary"
                      disabled={diarizeFirst.isPending || running}
                      onClick={() => diarizeFirst.mutate({ id: recording.id })}
                    >
                      Sprecher erkennen
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
