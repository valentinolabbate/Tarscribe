import { api } from "../../lib/api";
import { fmtDuration } from "../../lib/format";
import type { RagHit, RagSource } from "../../lib/types";

export function SourceAction({
  source,
  scoped,
  onOpenSource,
}: {
  source: RagSource | RagHit;
  scoped: boolean;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
}) {
  if (source.source_type === "document" && source.document_id != null) {
    const docId = source.document_id;
    return (
      <button
        className="btn ghost"
        style={{ padding: "2px 8px", fontSize: 11.5 }}
        onClick={() => void api.openDocument(docId).catch(() => {})}
      >
        Dokument öffnen
      </button>
    );
  }
  if (source.recording_id == null) return null;
  const recordingId = source.recording_id;
  const startSec = source.start_sec;
  return (
    <button
      className="btn ghost"
      style={{ padding: "2px 8px", fontSize: 11.5 }}
      onClick={() => onOpenSource(recordingId, startSec)}
    >
      {scoped ? (startSec != null ? `▶ ${fmtDuration(startSec)}` : "▶ Abspielen") : "Aufnahme öffnen"}
    </button>
  );
}
