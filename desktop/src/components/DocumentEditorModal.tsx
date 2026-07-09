import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { TopicDocumentContent } from "../lib/types";
import { DownloadIcon } from "./icons";
import { useToast } from "./Toast";
import { A4Preview } from "./summary-editor/A4Preview";
import { MarkdownEditor } from "./summary-editor/MarkdownEditor";

type EditorMode = "edit" | "split" | "preview";
type SaveStatus = "idle" | "saving" | "saved" | "error";

export function DocumentEditorModal({
  documentId,
  onClose,
}: {
  documentId: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: document, isLoading, error } = useQuery({
    queryKey: ["document-editor", documentId],
    queryFn: () => api.getDocumentContent(documentId),
  });
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<EditorMode>("split");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const initializedRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const savedRef = useRef("");
  const revisionRef = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const saveLoopRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!document || initializedRef.current === document.id) return;
    initializedRef.current = document.id;
    draftRef.current = document.content;
    savedRef.current = document.content;
    revisionRef.current = document.revision ?? 0;
    setDraft(document.content);
    setSaveStatus("idle");
  }, [document]);

  const save = useCallback(
    (content: string = draftRef.current) => {
      pendingRef.current = content;
      if (saveLoopRef.current) return saveLoopRef.current;
      const loop = async () => {
        while (pendingRef.current !== null) {
          const next = pendingRef.current;
          pendingRef.current = null;
          if (next === savedRef.current) continue;
          setSaveStatus("saving");
          try {
            const updated = await api.updateDocumentContent(documentId, next, revisionRef.current);
            revisionRef.current = updated.revision;
            savedRef.current = updated.content;
            queryClient.setQueryData<TopicDocumentContent>(["document-editor", documentId], updated);
            queryClient.invalidateQueries({ queryKey: ["documents"] });
            setSaveStatus("saved");
          } catch (saveError) {
            pendingRef.current = null;
            setSaveStatus("error");
            throw saveError;
          }
        }
      };
      saveLoopRef.current = loop().finally(() => {
        saveLoopRef.current = null;
      });
      return saveLoopRef.current;
    },
    [documentId, queryClient],
  );

  useEffect(() => {
    draftRef.current = draft;
    if (!document || draft === savedRef.current) return;
    const timer = window.setTimeout(() => void save(draft).catch(() => {}), 900);
    return () => window.clearTimeout(timer);
  }, [document, draft, save]);

  const close = useCallback(async () => {
    try {
      await save(draftRef.current);
      onClose();
    } catch (closeError) {
      toast((closeError as Error).message || "Speichern fehlgeschlagen", "error");
    }
  }, [onClose, save, toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  async function downloadOriginal() {
    try {
      await save(draftRef.current);
      await api.openDocument(documentId);
    } catch (downloadError) {
      toast((downloadError as Error).message || "Download fehlgeschlagen", "error");
    }
  }

  const title = document?.title ?? "Dokument";
  const statusLabel =
    saveStatus === "saving"
      ? "Speichert…"
      : saveStatus === "saved"
        ? "Gespeichert"
        : saveStatus === "error"
          ? "Speichern fehlgeschlagen"
          : "Änderungen werden automatisch gespeichert";

  return (
    <div className="modal-backdrop summary-editor-backdrop" onMouseDown={() => void close()}>
      <div
        className="modal summary-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Dokument bearbeiten: ${title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="summary-editor-titlebar">
          <div>
            <span className="summary-editor-eyebrow">Dokument-Kontext</span>
            <h2>{title}</h2>
            <p className={`summary-save-state ${saveStatus}`}>{statusLabel}</p>
          </div>
          <div className="summary-editor-actions">
            <button className="btn" onClick={() => void downloadOriginal()} disabled={!document}>
              <DownloadIcon width={14} height={14} /> Originaldatei
            </button>
            <button className="btn primary" onClick={() => void close()}>
              Schließen
            </button>
          </div>
        </header>

        <div className="summary-editor-viewbar">
          <div className="summary-view-switch" role="group" aria-label="Editoransicht">
            {([
              ["edit", "Bearbeiten"],
              ["split", "Geteilt"],
              ["preview", "A4-Vorschau"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                className={mode === value ? "active" : ""}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span>⌘S speichert sofort</span>
        </div>

        {document?.error && (
          <div className="document-editor-warning">{document.error}</div>
        )}

        {isLoading ? (
          <div className="summary-editor-loading">Dokument wird geladen…</div>
        ) : error ? (
          <div className="summary-editor-loading error">{(error as Error).message}</div>
        ) : (
          <main className={`summary-editor-workspace mode-${mode}`}>
            {mode !== "preview" && (
              <section className="summary-editor-pane" aria-label="Dokument-Kontext bearbeiten">
                <MarkdownEditor
                  value={draft}
                  onChange={setDraft}
                  onSave={() => void save()}
                  placeholderText="Dokument-Kontext bearbeiten…"
                />
              </section>
            )}
            {mode !== "edit" && (
              <section className="summary-preview-pane" aria-label="A4-Vorschau">
                <A4Preview content={draft} title={title} />
              </section>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
