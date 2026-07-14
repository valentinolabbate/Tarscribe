import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveRecordingHandle } from "../hooks/useLiveRecording";
import type { LiveSpeaker, LiveTranscriptSnapshot, LiveSpeakerSnapshot, LiveWord } from "../lib/types";
import { StopIcon } from "./icons";

const fmt = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function UploadStatus({
  queueLength,
  hasError,
  receivedSec,
}: {
  queueLength: number;
  hasError: boolean;
  receivedSec: number;
}) {
  if (hasError) {
    return (
      <span className="live-upload-status error">
        ⚠ Upload-Fehler — Live-Vorschau unvollständig
      </span>
    );
  }
  if (queueLength > 0) {
    return (
      <span className="live-upload-status pending">
        {queueLength} Chunk{queueLength !== 1 ? "s" : ""} ausstehend
      </span>
    );
  }
  if (receivedSec > 0) {
    return <span className="live-upload-status ok">{fmt(receivedSec)} übertragen</span>;
  }
  return null;
}

function SpeakerChips({ snapshot }: { snapshot: LiveSpeakerSnapshot | null }) {
  if (!snapshot || snapshot.speakers.length === 0) return null;
  return (
    <div className="live-speakers">
      {snapshot.speakers.map((sp) => (
        <span
          key={sp.id}
          className={`live-speaker-chip match-${sp.match_status}`}
          title={
            sp.similarity != null
              ? `Ähnlichkeit: ${(sp.similarity * 100).toFixed(0)} %`
              : "Kein Match"
          }
        >
          {sp.display_name}
          {sp.match_status === "probable" && (
            <span className="live-match-badge" title="Vorläufig erkannt">?</span>
          )}
        </span>
      ))}
    </div>
  );
}

interface UtteranceGroup {
  speakerId: string | null;
  words: LiveWord[];
  hasProvisional: boolean;
}

function groupWords(words: LiveWord[]): UtteranceGroup[] {
  const groups: UtteranceGroup[] = [];
  for (const word of words) {
    const last = groups[groups.length - 1];
    // Null speaker_id (punctuation tokens etc.) inherits the running group's speaker
    // rather than starting a new anonymous block.
    const speakerId = word.speaker_id ?? last?.speakerId ?? null;
    if (last && last.speakerId === speakerId) {
      last.words.push(word);
      if (!word.is_final) last.hasProvisional = true;
    } else {
      groups.push({ speakerId, words: [word], hasProvisional: !word.is_final });
    }
  }
  return groups;
}

function groupWordsByTime(words: LiveWord[]): UtteranceGroup[] {
  const groups: UtteranceGroup[] = [];
  for (const word of words) {
    const last = groups[groups.length - 1];
    const groupStart = last?.words[0]?.start ?? word.start;
    const previousText = last?.words[last.words.length - 1]?.text.trimEnd() ?? "";
    const sentenceBreak = /[.!?]$/.test(previousText) && word.start - groupStart >= 4;
    if (!last || word.start - groupStart >= 12 || sentenceBreak) {
      groups.push({ speakerId: null, words: [word], hasProvisional: !word.is_final });
    } else {
      last.words.push(word);
      if (!word.is_final) last.hasProvisional = true;
    }
  }
  return groups;
}

function LiveTranscript({
  snapshot,
  speakers,
  showSpeakers,
  bodyRef,
}: {
  snapshot: LiveTranscriptSnapshot | null;
  speakers: LiveSpeaker[];
  showSpeakers: boolean;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [autoScroll, setAutoScroll] = useState(true);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(atBottom);
  }, [bodyRef]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [bodyRef, handleScroll]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snapshot?.revision, autoScroll, bodyRef]);

  if (!snapshot || snapshot.words.length === 0) {
    return (
      <div className="live-transcript-empty">
        <div className="spinner-sm" />
        Warte auf erstes Transkript…
      </div>
    );
  }

  const groups = showSpeakers ? groupWords(snapshot.words) : groupWordsByTime(snapshot.words);
  const speakerMap = new Map(speakers.map((s) => [s.id, s]));

  return (
    <>
      {!autoScroll && (
        <button
          className="live-scroll-to-end"
          onClick={() => {
            const el = bodyRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setAutoScroll(true);
          }}
        >
          ↓ Zurück zum Ende
        </button>
      )}
      <div className="live-transcript">
        {groups.map((grp, i) => {
          const sp = grp.speakerId ? speakerMap.get(grp.speakerId) : null;
          const name = showSpeakers
            ? sp?.display_name ?? (grp.speakerId ? "Unbekannt" : "")
            : fmt(grp.words[0]?.start ?? 0);
          // trimStart: faster-whisper prefixes words with a space; the first word of
          // a new group would otherwise render with a leading blank.
          const text = grp.words.map((w) => w.text).join("").trimStart();

          return (
            <div key={i} className="live-utterance">
              {name && (
                <span
                  className={`live-utterance-speaker match-${sp?.match_status ?? "none"}`}
                  title={
                    sp?.similarity != null
                      ? `Ähnlichkeit: ${(sp.similarity * 100).toFixed(0)} %`
                      : undefined
                  }
                >
                  {name}
                  {sp?.match_status === "probable" && <span className="live-match-badge">?</span>}
                </span>
              )}
              <span className={grp.hasProvisional ? "live-text-provisional" : "live-text-stable"}>
                {text}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

interface Props {
  topicName: string;
  elapsed: number;
  state: "starting" | "recording" | "paused" | "saving" | "transcribing";
  handle: LiveRecordingHandle | null;
  showLiveSpeakers: boolean;
  finalTranscriptionJob: {
    jobId: number;
    progress: number;
    status: "pending" | "running" | "done" | "failed" | "canceled";
    error: string | null;
  } | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function LiveRecordingDetail({
  topicName,
  elapsed,
  state,
  handle,
  showLiveSpeakers,
  finalTranscriptionJob,
  onPause,
  onResume,
  onStop,
}: Props) {
  const isActive = state === "recording" || state === "paused";
  const bodyRef = useRef<HTMLDivElement>(null);
  const transcriptSnapshot = handle?.transcriptSnapshot ?? null;
  const showSpeakers = transcriptSnapshot?.speaker_detection_enabled ?? showLiveSpeakers;
  const speakerSnapshot = handle?.speakerSnapshot ?? null;
  const activeSpeakerIds = new Set(
    (transcriptSnapshot?.words ?? [])
      .map((word) => word.speaker_id)
      .filter((speakerId): speakerId is string => !!speakerId),
  );
  const visibleSpeakers = (speakerSnapshot?.speakers ?? []).filter((speaker) =>
    activeSpeakerIds.has(speaker.id),
  );
  const visibleSpeakerSnapshot =
    speakerSnapshot && visibleSpeakers.length > 0
      ? { ...speakerSnapshot, speakers: visibleSpeakers }
      : null;
  const finalPct = Math.round((finalTranscriptionJob?.progress ?? 0) * 100);

  return (
    <div className="live-detail">
      <div className="live-detail-header">
        <div className="live-detail-title">
          <span className={`rec-pulse ${state === "recording" ? "recording" : ""}`} />
          <span>{topicName}</span>
          {state === "starting" && <span className="live-state-badge">Startet…</span>}
          {state === "saving" && <span className="live-state-badge">Speichert…</span>}
          {state === "transcribing" && <span className="live-state-badge">Transkribiert final…</span>}
          {state === "paused" && <span className="live-state-badge paused">Pausiert</span>}
        </div>

        <div className="live-detail-timer">{fmt(elapsed)}</div>

        {isActive && (
          <div className="live-detail-controls">
            <button className="btn ghost" onClick={state === "paused" ? onResume : onPause}>
              {state === "paused" ? "Fortsetzen" : "Pause"}
            </button>
            <button className="btn ghost danger" title="Aufnahme beenden" onClick={onStop}>
              <StopIcon width={14} height={14} />
              Stoppen
            </button>
          </div>
        )}
      </div>

      {handle && (
        <div className="live-detail-upload">
          <UploadStatus
            queueLength={handle.queueLength}
            hasError={handle.hasUploadError}
            receivedSec={handle.receivedDurationSec}
          />
          {handle.degraded && showSpeakers && (
            <span className="live-degraded-badge" title={handle.degradedReason ?? undefined}>
              {handle.degradedReason === "no_hf_token"
                ? "Kein HF-Token — Sprechererkennung deaktiviert"
                : "Live-Diarisierung nicht verfügbar"}
            </span>
          )}
        </div>
      )}

      {state === "transcribing" && finalTranscriptionJob && (
        <div className="live-final-transcription" role="status" aria-live="polite">
          <div>
            <strong>
              {finalTranscriptionJob.status === "pending"
                ? "Finale Transkription wartet…"
                : `Finale Transkription läuft… ${finalPct}%`}
            </strong>
            <span>Die Aufnahme öffnet sich automatisch, sobald das saubere Transkript fertig ist.</span>
          </div>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${finalPct}%` }} />
          </div>
        </div>
      )}

      {showSpeakers && <SpeakerChips snapshot={visibleSpeakerSnapshot} />}

      <div className="live-detail-body" ref={bodyRef}>
        <LiveTranscript
          snapshot={transcriptSnapshot}
          speakers={showSpeakers ? visibleSpeakers : []}
          showSpeakers={showSpeakers}
          bodyRef={bodyRef}
        />
      </div>

      <div className="live-detail-note">
        Live-Vorschau ist provisorisch. Das finale Transkript erscheint nach der Verarbeitung.
      </div>
    </div>
  );
}
