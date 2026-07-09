import { useRef, useState } from "react";
import { useDeleteDocument, useDocuments, useUploadDocument } from "../hooks/queries";
import { fmtDate } from "../lib/format";
import type { DocumentStatus } from "../lib/types";
import { api } from "../lib/api";
import { useToast } from "./Toast";
import { DocIcon, DownloadIcon, TrashIcon, UploadIcon } from "./icons";

const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.text";

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "Wartet auf Indexierung…",
  indexing: "Wird indexiert…",
  ready: "Indexiert",
  failed: "Fehler",
};

/**
 * Upload + manage reference documents for a topic (or a single recording).
 * Their text is RAG-indexed so they surface in search and the knowledge chat.
 */
export function DocumentsPanel({
  topicId,
  recordingId,
  onOpenDocument,
  compact = false,
}: {
  topicId: number;
  /** When set, documents are attached to this recording instead of the topic. */
  recordingId?: number;
  onOpenDocument: (documentId: number) => void;
  /** Compact footer variant for secondary document context inside another workflow. */
  compact?: boolean;
}) {
  const { data: docs, isLoading } = useDocuments({ topicId, recordingId });
  const upload = useUploadDocument();
  const del = useDeleteDocument();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        await upload.mutateAsync({ topicId, recordingId, file });
      }
    } catch (e) {
      toast(`Dokument konnte nicht hochgeladen werden: ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const items = docs ?? [];

  return (
    <section className={`documents-panel${compact ? " compact" : ""}`}>
      <div className="documents-head">
        <div className="documents-title">
          <DocIcon width={compact ? 16 : 18} height={compact ? 16 : 18} />
          <h3>Dokumente</h3>
          {items.length > 0 && <span className="documents-count">{items.length}</span>}
        </div>
        <button
          className="btn ghost"
          onClick={() => fileInput.current?.click()}
          disabled={busy || upload.isPending}
        >
          <UploadIcon width={compact ? 14 : 16} height={compact ? 14 : 16} /> Hochladen
        </button>
      </div>
      <p className="documents-hint">
        {compact
          ? "Kontext für Suche und Chat in dieser Aufnahme."
          : "PDF, Word, Text oder Markdown werden im Archiv durchsuchbar."}
      </p>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={async (e) => {
          const input = e.currentTarget;
          await handleFiles(input.files);
          input.value = "";
        }}
      />

      {isLoading ? (
        <div className="documents-empty">Lade…</div>
      ) : items.length === 0 && compact ? (
        <div className="documents-empty documents-empty-inline">
          <span>Noch keine Dokumente angehängt.</span>
        </div>
      ) : items.length === 0 ? (
        <div className="documents-empty empty-next compact-empty">
          <span>Noch keine Dokumente.</span>
        </div>
      ) : (
        <ul className="documents-list">
          {items.map((doc) => (
            <li key={doc.id} className="document-row">
              <span className={`document-icon ${doc.status}`}>
                <DocIcon width={18} height={18} />
              </span>
              <div className="document-meta">
                <div className="document-title" title={doc.original_filename ?? undefined}>
                  {doc.title}
                </div>
                <div className="document-sub">
                  <span className={`document-status ${doc.status}`}>
                    {doc.status === "failed" && doc.error
                      ? doc.error
                      : STATUS_LABEL[doc.status]}
                  </span>
                  <span>·</span>
                  <span>{fmtDate(doc.created_at)}</span>
                </div>
              </div>
              <button
                className="btn ghost"
                title="Im Editor öffnen"
                onClick={() => onOpenDocument(doc.id)}
              >
                <DocIcon width={16} height={16} />
              </button>
              <button
                className="btn ghost"
                title="Originaldatei herunterladen"
                onClick={() =>
                  api
                    .openDocument(doc.id)
                    .catch((e) => toast(`Download fehlgeschlagen: ${(e as Error).message}`, "error"))
                }
              >
                <DownloadIcon width={16} height={16} />
              </button>
              <button
                className="btn ghost danger"
                title="Löschen"
                onClick={() => {
                  if (confirm(`„${doc.title}" löschen?`)) del.mutate(doc.id);
                }}
              >
                <TrashIcon width={16} height={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {(busy || upload.isPending) && (
        <div className="documents-empty">Wird hochgeladen…</div>
      )}
    </section>
  );
}
