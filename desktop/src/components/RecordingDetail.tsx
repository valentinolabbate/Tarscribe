import { useEffect, useRef, useState } from "react";
import { AudioPlayer, type PlayerHandle } from "./AudioPlayer";
import {
  useActiveJob,
  useDiarization,
  useDiarize,
  useEnrollSpeaker,
  useSpeakerEdits,
  useTranscribe,
  useTranscript,
  useUpdateRecording,
} from "../hooks/queries";
import { clearJobFor, useJobFor } from "../hooks/useJobs";
import { api } from "../lib/api";
import { fmtDuration, jobPhaseLabel } from "../lib/format";
import type { DiarizationData, Recording } from "../lib/types";
import { useToast } from "./Toast";
import { SpeakerIdIcon, WaveIcon } from "./icons";
import { SummaryPanel } from "./SummaryPanel";
import { TuningPanel } from "./TuningPanel";

const SPEAKER_COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899",
  "#06b6d4", "#8b5cf6", "#ef4444", "#84cc16",
];
const colorFor = (label: string, all: string[]) =>
  SPEAKER_COLORS[Math.max(0, all.indexOf(label)) % SPEAKER_COLORS.length];

const ts = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

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
              <option value="">zusammenführen…</option>
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

export function RecordingDetail({ recording, onBack }: { recording: Recording; onBack: () => void }) {
  const job = useJobFor(recording.id);
  const transcribe = useTranscribe();
  const diarizeFirst = useDiarize();
  const { reassign } = useSpeakerEdits(recording.id);
  const updateRec = useUpdateRecording();
  const toast = useToast();
  // "ready" = transcription + any diarization done
  // "diarizing" = transcription done, diarization in progress → still show transcript
  const isFullyReady = recording.status === "ready";
  const isTranscribed = isFullyReady || recording.status === "diarizing";
  // Fallback: recording.status reflects backend state even if WS event was missed
  const statusRunning = recording.status === "transcribing" || recording.status === "diarizing";

  const { data: transcript } = useTranscript(recording.id, isTranscribed);
  const { data: diar } = useDiarization(recording.id, isTranscribed && !!transcript);

  const [showTuning, setShowTuning] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const playerRef = useRef<PlayerHandle>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);

  const activeStart =
    diar?.utterances.find((u) => currentTime >= u.start && currentTime < u.end)?.start ?? -1;
  useEffect(() => {
    if (playing && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeStart, playing]);

  // If the server-side result is already present but the WS "done" event was
  // missed, the job stays stuck at "pending/0%". Clear it so the UI unblocks.
  useEffect(() => {
    if (!job) return;
    const stuck = job.status === "pending" || job.status === "running";
    if (!stuck) return;
    if (job.phase === "asr" && isFullyReady) clearJobFor(recording.id);
    if (job.phase === "diarization" && diar) clearJobFor(recording.id);
  }, [isFullyReady, diar, job, recording.id]);

  // Use recording.status as fallback when WS job event hasn't arrived yet
  const running = !!(job && (job.status === "running" || job.status === "pending")) || statusRunning;

  // Poll the backend every 1.5 s as a fallback when WS events are missed.
  const { data: polledJob } = useActiveJob(recording.id, running);
  // Prefer live WS store data (updated immediately), fall back to polled data.
  const activeJob = job ?? polledJob ?? null;

  const startingPhase = transcribe.isPending
    ? "Starte Transkription"
    : diarizeFirst.isPending
      ? "Starte Sprechererkennung"
      : null;
  const pct = Math.round((activeJob?.progress ?? 0) * 100);
  // Phase label: prefer live job data, fall back to recording.status
  const phaseLabel = activeJob
    ? jobPhaseLabel(activeJob.phase)
    : recording.status === "diarizing"
      ? jobPhaseLabel("diarization")
      : jobPhaseLabel("asr");
  const labels = diar?.speakers.map((s) => s.label) ?? [];

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="btn ghost" onClick={onBack}>← Zurück</button>
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
        <span className="rec-sub">{fmtDuration(recording.duration_sec)}</span>
      </div>

      {(running || startingPhase) && (
        <div className="transcribe-box" style={{ marginBottom: 14 }}>
          <div className="rec-sub" style={{ marginBottom: 8 }}>
            {startingPhase ? `${startingPhase}…` : `${phaseLabel}… ${pct}%`}
          </div>
          <div className="progress"><div className="progress-bar" style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      {!isTranscribed && !running && (
        <div className="transcribe-box" style={{ textAlign: "center" }}>
          <div className="rec-icon" style={{ margin: "0 auto 12px" }}><WaveIcon /></div>
          <div style={{ marginBottom: 12 }}>Diese Aufnahme wurde noch nicht transkribiert.</div>
          <button className="btn primary" disabled={transcribe.isPending} onClick={() => transcribe.mutate({ id: recording.id })}>
            Jetzt transkribieren
          </button>
          {job?.status === "failed" && <div style={{ color: "var(--danger)", marginTop: 10 }}>{job.error}</div>}
        </div>
      )}

      {isTranscribed && transcript && (
        <>
          <AudioPlayer
            ref={playerRef}
            recordingId={recording.id}
            onTime={setCurrentTime}
            onPlaying={setPlaying}
          />

          <div className="toolbar">
            <div className="rec-sub">
              {transcript.words.length} Wörter · {transcript.asr_model}
              {diar ? ` · ${diar.speakers.length} Sprecher` : ""}
            </div>
            <div className="spacer" />
            {!diar ? (
              <button className="btn" disabled={diarizeFirst.isPending || running} onClick={() => diarizeFirst.mutate({ id: recording.id })}>
                <SpeakerIdIcon width={16} height={16} /> Sprecher erkennen
              </button>
            ) : (
              <button className={showTuning ? "btn active" : "btn"} onClick={() => setShowTuning((v) => !v)}>
                Tuning
              </button>
            )}
            <div className="export-wrap">
              <button className="btn ghost" onClick={() => setExportOpen((v) => !v)}>Export ▾</button>
              {exportOpen && (
                <div className="export-menu" onMouseLeave={() => setExportOpen(false)}>
                  {["txt", "srt", "vtt", "json"].map((f) => (
                    <button key={f} onClick={() => { api.downloadExport(recording.id, f, recording.title); setExportOpen(false); }}>
                      .{f.toUpperCase()}
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
                      } catch (e) {
                        toast((e as Error).message, "error");
                      }
                    }}
                  >
                    📁 An Ordner senden
                  </button>
                </div>
              )}
            </div>
          </div>

          {job?.status === "failed" && job.phase === "diarization" && (
            <div className="transcribe-box" style={{ color: "var(--danger)", marginBottom: 14 }}>
              Diarisierung fehlgeschlagen: {job.error}
            </div>
          )}

          {diar && showTuning && (
            <TuningPanel recordingId={recording.id} initial={diar.params} disabled={!!running} />
          )}

          <SummaryPanel recordingId={recording.id} />

          {diar ? (
            <>
              <SpeakerLegend recordingId={recording.id} diar={diar} labels={labels} />
              <div className="transcript">
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
            </>
          ) : (
            <div className="transcript"><p className="transcript-text">{transcript.text}</p></div>
          )}
        </>
      )}
    </div>
  );
}
