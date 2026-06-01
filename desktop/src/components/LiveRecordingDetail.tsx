import { useEffect, useRef } from "react";
import type { LiveRecordingHandle } from "../hooks/useLiveRecording";
import type { LiveSpeaker, LiveTranscriptSnapshot, LiveSpeakerSnapshot, LiveWord } from "../lib/types";
import { StopIcon } from "./icons";

const fmt = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

// ── Upload status pill ────────────────────────────────────────────────────────

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

// ── Speaker chips ─────────────────────────────────────────────────────────────

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

// ── Utterance rendering ───────────────────────────────────────────────────────

interface UtteranceGroup {
  speakerId: string | null;
  words: LiveWord[];
  hasProvisional: boolean;
}

function groupWords(words: LiveWord[]): UtteranceGroup[] {
  const groups: UtteranceGroup[] = [];
  for (const word of words) {
    const last = groups[groups.length - 1];
    if (last && last.speakerId === (word.speaker_id ?? null)) {
      last.words.push(word);
      if (!word.is_final) last.hasProvisional = true;
    } else {
      groups.push({
        speakerId: word.speaker_id ?? null,
        words: [word],
        hasProvisional: !word.is_final,
      });
    }
  }
  return groups;
}

function LiveTranscript({
  snapshot,
  speakers,
}: {
  snapshot: LiveTranscriptSnapshot | null;
  speakers: LiveSpeaker[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [snapshot?.revision]);

  if (!snapshot || snapshot.words.length === 0) {
    return (
      <div className="live-transcript-empty">
        <div className="spinner-sm" />
        Warte auf erstes Transkript…
      </div>
    );
  }

  const groups = groupWords(snapshot.words);
  const speakerMap = new Map(speakers.map((s) => [s.id, s]));

  return (
    <div className="live-transcript">
      {groups.map((grp, i) => {
        const sp = grp.speakerId ? speakerMap.get(grp.speakerId) : null;
        const name = sp?.display_name ?? (grp.speakerId ? "Unbekannt" : "");
        const text = grp.words.map((w) => w.text).join("");

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
      <div ref={bottomRef} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  topicName: string;
  elapsed: number;
  state: "starting" | "recording" | "paused" | "saving";
  handle: LiveRecordingHandle | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function LiveRecordingDetail({
  topicName,
  elapsed,
  state,
  handle,
  onPause,
  onResume,
  onStop,
}: Props) {
  const isActive = state === "recording" || state === "paused";

  return (
    <div className="live-detail">
      <div className="live-detail-header">
        <div className="live-detail-title">
          <span className={`rec-pulse ${state === "recording" ? "recording" : ""}`} />
          <span>{topicName}</span>
          {state === "starting" && <span className="live-state-badge">Startet…</span>}
          {state === "saving" && <span className="live-state-badge">Speichert…</span>}
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
          {handle.degraded && (
            <span className="live-degraded-badge" title={handle.degradedReason ?? undefined}>
              {handle.degradedReason === "no_hf_token"
                ? "Kein HF-Token — Sprechererkennung deaktiviert"
                : "Live-Diarisierung nicht verfügbar"}
            </span>
          )}
        </div>
      )}

      <SpeakerChips snapshot={handle?.speakerSnapshot ?? null} />

      <div className="live-detail-body">
        <LiveTranscript
          snapshot={handle?.transcriptSnapshot ?? null}
          speakers={handle?.speakerSnapshot?.speakers ?? []}
        />
      </div>

      <div className="live-detail-note">
        Live-Vorschau ist provisorisch. Das finale Transkript erscheint nach der Verarbeitung.
      </div>
    </div>
  );
}
