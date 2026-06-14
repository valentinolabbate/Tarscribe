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
import type { DiarizationData, Recording } from "../lib/types";
import { useToast } from "./Toast";
import { ChatIcon, SpeakerIdIcon, SummaryIcon, WaveIcon } from "./icons";
import { ActionItemsPanel } from "./ActionItemsPanel";
import { ChaptersBar } from "./ChaptersBar";
import { ChatPanel } from "./ChatPanel";
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

export function RecordingDetail({
  recording,
  onBack,
  onOpenSettings,
}: {
  recording: Recording;
  onBack: () => void;
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

  const activeStart =
    diar?.utterances.find((u) => currentTime >= u.start && currentTime < u.end)?.start ?? -1;
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
      ? `${transcript.words.length} Wörter`
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

      {(running || startingPhase) && (
        <div className="detail-progress">
          <div>
            <strong>{startingPhase ? `${startingPhase}...` : `${phaseLabel}... ${pct}%`}</strong>
            <span>{running ? "Die Ansicht aktualisiert sich automatisch." : "Der Auftrag wird vorbereitet."}</span>
          </div>
          <div className="progress"><div className="progress-bar" style={{ width: `${pct}%` }} /></div>
        </div>
      )}

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

      {!transcript && !transcriptPending && (
        <DetailEmptyState
          running={!!running}
          startingPhase={startingPhase}
          transcribePending={transcribe.isPending}
          error={job?.status === "failed" ? job.error : null}
          onTranscribe={() => transcribe.mutate({ id: recording.id })}
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
                    <h2>Fragen & Suchen</h2>
                    <p>Durchsuche nur diese Aufnahme oder frage den lokalen Wissens-Chat.</p>
                  </div>
                  <ChatIcon width={20} height={20} />
                </div>
                <ChatPanel
                  embedded
                  scopeRecording={{ id: recording.id, title: recording.title }}
                  onOpenSource={(_rec, start) => playerRef.current?.seek(start ?? 0)}
                />
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
