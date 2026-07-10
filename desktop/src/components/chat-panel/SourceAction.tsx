import { api } from "../../lib/api";
import { fmtDuration } from "../../lib/format";
import { openExternalUrl } from "../../lib/openExternalUrl";
import type { RagSourceType } from "../../lib/types";
import { useToast } from "../Toast";

export interface SourceLike {
  source_type: RagSourceType;
  document_id?: number | null;
  source_url?: string | null;
  recording_id?: number | null;
  start_sec?: number | null;
}

export function SourceAction({
  source,
  scoped,
  onOpenSource,
  onOpenDocument,
}: {
  source: SourceLike;
  scoped: boolean;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
}) {
  const toast = useToast();
  if (source.source_type === "document" && source.document_id != null) {
    const docId = source.document_id;
    return (
      <button
        className="btn ghost"
        style={{ padding: "2px 8px", fontSize: 11.5 }}
        onClick={() => {
          if (onOpenDocument) onOpenDocument(docId);
          else void api.openDocument(docId).catch(() => {});
        }}
      >
        Dokument öffnen
      </button>
    );
  }
  if (source.source_type === "web" && source.source_url) {
    return (
      <button
        className="btn ghost"
        style={{ padding: "2px 8px", fontSize: 11.5 }}
        onClick={() => {
          void openExternalUrl(source.source_url ?? "").catch(() =>
            toast("Webseite konnte nicht geöffnet werden", "error"),
          );
        }}
      >
        Web öffnen
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
