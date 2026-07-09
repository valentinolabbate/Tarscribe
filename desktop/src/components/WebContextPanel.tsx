import { FormEvent, useState } from "react";
import { useCreateWebContext, useDeleteDocument, useDocuments } from "../hooks/queries";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import type { DocumentStatus } from "../lib/types";
import { DocIcon, DownloadIcon, LinkIcon, TrashIcon } from "./icons";
import { useToast } from "./Toast";

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "Wartet auf Indexierung…",
  indexing: "Wird indexiert…",
  ready: "Indexiert",
  failed: "Fehler",
};

export function WebContextPanel({
  topicId,
  onOpenDocument,
}: {
  topicId: number;
  onOpenDocument: (documentId: number) => void;
}) {
  const { data: docs, isLoading } = useDocuments({ topicId, sourceKind: "web" });
  const create = useCreateWebContext();
  const del = useDeleteDocument();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [maxPages, setMaxPages] = useState(8);
  const [maxDepth, setMaxDepth] = useState(1);
  const items = docs ?? [];
  const busy = create.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanUrl = url.trim();
    if (!cleanUrl || busy) return;
    try {
      await create.mutateAsync({
        topicId,
        url: cleanUrl,
        title: title.trim() || undefined,
        maxPages,
        maxDepth,
      });
      setUrl("");
      setTitle("");
      toast("Web-Kontext gespeichert.");
    } catch (error) {
      toast(`Web-Kontext konnte nicht geladen werden: ${(error as Error).message}`, "error");
    }
  }

  return (
    <section className="documents-panel web-context-panel">
      <div className="documents-head">
        <div className="documents-title">
          <LinkIcon width={18} height={18} />
          <h3>Kontext</h3>
          {items.length > 0 && <span className="documents-count">{items.length}</span>}
        </div>
      </div>
      <p className="documents-hint">
        Hole mehr aus Zusammenfassungen heraus, indem wichtige Webseiten gezielt als Kontext bereitstehen.
      </p>

      <form className="web-context-form" onSubmit={(event) => void submit(event)}>
        <label className="web-context-url">
          <LinkIcon width={15} height={15} />
          <input
            type="url"
            placeholder="https://beispiel.de/projekt"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <input
          className="web-context-title-input"
          type="text"
          placeholder="Titel optional"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="web-context-number">
          <span>Seiten</span>
          <input
            type="number"
            min={1}
            max={25}
            value={maxPages}
            onChange={(event) =>
              setMaxPages(Math.min(25, Math.max(1, Number(event.target.value) || 1)))
            }
          />
        </label>
        <label className="web-context-number">
          <span>Tiefe</span>
          <input
            type="number"
            min={0}
            max={3}
            value={maxDepth}
            onChange={(event) =>
              setMaxDepth(Math.min(3, Math.max(0, Number(event.target.value) || 0)))
            }
          />
        </label>
        <button className="btn primary" disabled={busy || !url.trim()}>
          {busy ? "Lädt…" : "Webseite holen"}
        </button>
      </form>

      {busy && <div className="documents-empty">Website wird geladen und aufbereitet…</div>}

      {isLoading ? (
        <div className="documents-empty">Lade…</div>
      ) : items.length === 0 ? (
        <div className="documents-empty empty-next compact-empty">
          <span>Noch kein Web-Kontext.</span>
        </div>
      ) : (
        <ul className="documents-list">
          {items.map((doc) => (
            <li key={doc.id} className="document-row">
              <span className={`document-icon ${doc.status}`}>
                <LinkIcon width={18} height={18} />
              </span>
              <div className="document-meta">
                <div className="document-title" title={doc.source_url ?? undefined}>
                  {doc.title}
                </div>
                <div className="document-sub">
                  {doc.source_url && <span>{hostFromUrl(doc.source_url)}</span>}
                  {doc.source_url && <span>·</span>}
                  <span>{doc.crawl_pages || 1} Seiten</span>
                  <span>·</span>
                  <span className={`document-status ${doc.status}`}>
                    {doc.status === "failed" && doc.error ? doc.error : STATUS_LABEL[doc.status]}
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
                title="HTML-Snapshot herunterladen"
                onClick={() =>
                  api
                    .openDocument(doc.id)
                    .catch((error) =>
                      toast(`Download fehlgeschlagen: ${(error as Error).message}`, "error"),
                    )
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
    </section>
  );
}

function hostFromUrl(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}
