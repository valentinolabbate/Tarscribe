import type { RefObject } from "react";
import type { PlayerHandle } from "../AudioPlayer";
import type { DiarizationData, TranscriptData } from "../../lib/types";
import { colorFor, timestamp, type Sentence } from "./model";

type ReassignMutation = {
  mutate: (payload: { start: number; end: number; speaker: string }) => void;
};

export function TranscriptPanel({
  transcript,
  diar,
  transcriptMeta,
  sentences,
  currentTime,
  labels,
  activeRef,
  playerRef,
  reassign,
  onOpenSpeakers,
}: {
  transcript: TranscriptData;
  diar?: DiarizationData;
  transcriptMeta: string;
  sentences: Sentence[];
  currentTime: number;
  labels: string[];
  activeRef: RefObject<HTMLDivElement | null>;
  playerRef: RefObject<PlayerHandle | null>;
  reassign: ReassignMutation;
  onOpenSpeakers: () => void;
}) {
  return (
    <section className="detail-panel transcript-workspace">
      <div className="detail-panel-head">
        <div>
          <h2>Transkript</h2>
          <p>{transcriptMeta}</p>
        </div>
        {diar && (
          <button className="btn ghost" onClick={onOpenSpeakers}>
            Sprecher bearbeiten
          </button>
        )}
      </div>

      {diar ? (
        <div className="transcript transcript-focused">
          {diar.utterances.map((utterance, index) => {
            const active = currentTime >= utterance.start && currentTime < utterance.end;
            return (
              <div
                className={`utterance ${active ? "active" : ""}`}
                key={index}
                ref={active ? activeRef : undefined}
              >
                <div className="utt-head">
                  <select
                    className="speaker-chip-sel"
                    style={{ background: colorFor(utterance.speaker, labels) }}
                    value={utterance.speaker}
                    onChange={(event) => {
                      if (event.target.value !== utterance.speaker) {
                        reassign.mutate({
                          start: utterance.start,
                          end: utterance.end,
                          speaker: event.target.value,
                        });
                      }
                    }}
                    title="Diesen Abschnitt einem Sprecher zuweisen"
                  >
                    {diar.speakers.map((speaker) => (
                      <option key={speaker.label} value={speaker.label}>
                        {speaker.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="utt-time"
                    onClick={() => playerRef.current?.seek(utterance.start)}
                    title="Abspielen ab hier"
                  >
                    ▶ {timestamp(utterance.start)}
                  </button>
                </div>
                <p className="utt-text" onClick={() => playerRef.current?.seek(utterance.start)}>
                  {utterance.text}
                </p>
              </div>
            );
          })}
        </div>
      ) : sentences.length > 0 ? (
        <div className="transcript transcript-focused">
          {sentences.map((sentence, index) => {
            const active = currentTime >= sentence.start && currentTime < sentence.end;
            return (
              <div
                className={`utterance plain ${active ? "active" : ""}`}
                key={index}
                ref={active ? activeRef : undefined}
              >
                <div className="utt-head">
                  <button
                    className="utt-time"
                    onClick={() => playerRef.current?.seek(sentence.start)}
                    title="Abspielen ab hier"
                  >
                    ▶ {timestamp(sentence.start)}
                  </button>
                </div>
                <p className="utt-text" onClick={() => playerRef.current?.seek(sentence.start)}>
                  {sentence.text}
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
  );
}
