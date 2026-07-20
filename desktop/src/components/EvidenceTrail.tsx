import type { CSSProperties } from "react";
import { fmtDuration } from "../lib/format";

export function EvidenceTrail({
  recordingId,
  recordingTitle,
  startSec,
  positionLabel,
  sourceType,
  quote,
  topicName,
  topicColor,
  speaker,
  missing = false,
  compact = false,
  onOpenRecording,
}: {
  recordingId?: number | null;
  recordingTitle?: string | null;
  startSec?: number | null;
  positionLabel?: string | null;
  sourceType?: string | null;
  quote?: string | null;
  topicName?: string | null;
  topicColor?: string | null;
  speaker?: string | null;
  missing?: boolean;
  compact?: boolean;
  onOpenRecording?: (recordingId: number, startSec?: number | null) => void;
}) {
  const canOpen = !missing && recordingId != null && onOpenRecording != null;
  const className = `evidence-trail ${compact ? "compact" : ""} ${missing ? "missing" : ""} ${canOpen ? "interactive" : "static"}`;
  const style = {
    "--evidence-color": topicColor || "var(--accent)",
  } as CSSProperties;
  const content = (
    <>
      <span className="evidence-trail-signal" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="evidence-trail-copy">
        <span className="evidence-trail-meta">
          <code>{positionLabel || (startSec != null ? fmtDuration(startSec) : missing ? "—:—" : "Quelle")}</code>
          <strong>{missing ? "Belegspur fehlt" : recordingTitle || "Aufnahme"}</strong>
          {sourceType && <span>{sourceType}</span>}
          {topicName && <span>{topicName}</span>}
          {speaker && <span>{speaker}</span>}
        </span>
        {!compact && (
          quote ? <q>{quote}</q> : <em>{missing ? "Zitat oder Zeitmarke konnte nicht eindeutig zugeordnet werden." : "Originalstelle öffnen"}</em>
        )}
      </span>
    </>
  );

  if (!canOpen) {
    return <div className={className} style={style}>{content}</div>;
  }

  return (
    <button
      type="button"
      className={className}
      style={style}
      title="Originalstelle öffnen"
      onClick={() => onOpenRecording(recordingId, startSec)}
    >
      {content}
    </button>
  );
}
