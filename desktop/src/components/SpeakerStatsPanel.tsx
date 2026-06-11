import { useSpeakerStats } from "../hooks/queries";
import { fmtDuration } from "../lib/format";

/** Mirrors the transcript's speaker colors (same palette + label order). */
export function SpeakerStatsPanel({
  recordingId,
  labels,
  colorFor,
}: {
  recordingId: number;
  labels: string[];
  colorFor: (label: string) => string;
}) {
  const { data: stats } = useSpeakerStats(recordingId);
  if (!stats || stats.speakers.length === 0) return null;

  const maxShare = Math.max(...stats.speakers.map((s) => s.share), 0.0001);
  const hasInterruptions = stats.speakers.some(
    (s) => s.interruptions_made > 0 || s.interruptions_received > 0,
  );

  return (
    <div className="speaker-stats">
      <h3>Redeanteile</h3>
      <div className="speaker-stats-bars">
        {stats.speakers.map((sp) => (
          <div key={sp.label} className="speaker-stat-row">
            <span className="speaker-stat-name" title={sp.label}>
              <span className="topic-dot" style={{ background: colorFor(sp.label) }} />
              {sp.name}
            </span>
            <div className="speaker-stat-bar-track">
              <div
                className="speaker-stat-bar"
                style={{
                  width: `${Math.max(2, (sp.share / maxShare) * 100)}%`,
                  background: colorFor(sp.label),
                }}
              />
            </div>
            <span className="speaker-stat-value">
              {(sp.share * 100).toFixed(0)} % · {fmtDuration(sp.talk_sec)}
            </span>
          </div>
        ))}
      </div>

      <h3>Gesprächsverlauf</h3>
      <div className="speaker-timeline" title="Wer spricht wann — ein Band pro Sprecher">
        {stats.speakers.map((sp) => {
          const maxVal = Math.max(...sp.timeline, 0.0001);
          return (
            <div key={sp.label} className="speaker-timeline-row">
              <span className="speaker-stat-name">{sp.name}</span>
              <div className="speaker-timeline-track">
                {sp.timeline.map((v, i) => (
                  <span
                    key={i}
                    className="speaker-timeline-cell"
                    style={{
                      background: colorFor(sp.label),
                      opacity: v > 0 ? 0.25 + 0.75 * (v / maxVal) : 0,
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <div className="speaker-timeline-axis">
          <span>0:00</span>
          <span>{fmtDuration(stats.duration_sec)}</span>
        </div>
      </div>

      <div className="speaker-stats-facts">
        {stats.speakers.map((sp) => (
          <div key={sp.label} className="speaker-stats-fact">
            <strong>{sp.name}</strong>
            <span>
              {sp.segments} Wortmeldungen · längste {fmtDuration(sp.longest_sec)}
              {hasInterruptions &&
                ` · unterbricht ${sp.interruptions_made}× · wird ${sp.interruptions_received}× unterbrochen`}
            </span>
          </div>
        ))}
      </div>
      {labels.length !== stats.speakers.length && (
        <p className="speaker-stats-note">
          Statistik basiert auf der aktiven Sprechererkennung; manuelle Korrekturen einzelner
          Textstellen sind nicht eingerechnet.
        </p>
      )}
    </div>
  );
}
