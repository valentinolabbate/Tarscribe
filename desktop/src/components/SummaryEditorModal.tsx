import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Summary } from "../lib/types";
import { DownloadIcon } from "./icons";
import { SummarySourcesPanel } from "./SummarySourcesPanel";
import { useToast } from "./Toast";
import { A4Preview } from "./summary-editor/A4Preview";
import { MarkdownEditor } from "./summary-editor/MarkdownEditor";

type EditorMode = "edit" | "split" | "preview";
type SaveStatus = "idle" | "saving" | "saved" | "error";

export function SummaryEditorModal({
  summaryId,
  recordingId,
  recordingTitle,
  onClose,
}: {
  summaryId: number;
  recordingId: number;
  recordingTitle: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: summary, isLoading, error } = useQuery({
    queryKey: ["summary-editor", summaryId],
    queryFn: () => api.getSummary(summaryId),
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
    if (!summary || initializedRef.current === summary.id) return;
    initializedRef.current = summary.id;
    draftRef.current = summary.content;
    savedRef.current = summary.content;
    revisionRef.current = summary.revision ?? 0;
    setDraft(summary.content);
    setSaveStatus("idle");
  }, [summary]);

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
            const updated = await api.updateSummary(summaryId, next, revisionRef.current);
            revisionRef.current = updated.revision;
            savedRef.current = updated.content;
            queryClient.setQueryData(["summary-editor", summaryId], updated);
            queryClient.setQueryData<Summary[]>(["summaries", recordingId], (current) =>
              current?.map((item) => (item.id === updated.id ? updated : item)),
            );
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
    [queryClient, recordingId, summaryId],
  );

  useEffect(() => {
    draftRef.current = draft;
    if (!summary || draft === savedRef.current) return;
    const timer = window.setTimeout(() => void save(draft).catch(() => {}), 900);
    return () => window.clearTimeout(timer);
  }, [draft, save, summary]);

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

  async function exportPdf() {
    try {
      await save(draftRef.current);
      await api.downloadSummaryPdf(summaryId, recordingTitle);
      toast("PDF exportiert", "success");
    } catch (exportError) {
      toast((exportError as Error).message || "PDF-Export fehlgeschlagen", "error");
    }
  }

  function restoreOriginal() {
    if (!summary) return;
    const original = summary.generated_content ?? summary.content;
    if (draft === original) return;
    if (!window.confirm("Den ursprünglichen KI-Text wiederherstellen?")) return;
    draftRef.current = original;
    setDraft(original);
  }

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
        aria-label={`Zusammenfassung bearbeiten: ${recordingTitle}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="summary-editor-titlebar">
          <div>
            <span className="summary-editor-eyebrow">Zusammenfassung</span>
            <h2>{recordingTitle}</h2>
            <p className={`summary-save-state ${saveStatus}`}>{statusLabel}</p>
          </div>
          <div className="summary-editor-actions">
            <button className="btn ghost" onClick={restoreOriginal} disabled={!summary}>
              Original
            </button>
            <button className="btn" onClick={() => void exportPdf()} disabled={!summary}>
              <DownloadIcon width={14} height={14} /> PDF
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

        {isLoading ? (
          <div className="summary-editor-loading">Zusammenfassung wird geladen…</div>
        ) : error ? (
          <div className="summary-editor-loading error">{(error as Error).message}</div>
        ) : (
          <>
            <SummarySourcesPanel
              raw={summary?.sources ?? null}
              onOpenSource={() => {}}
              onOpenDocument={(docId) => void api.openDocument(docId).catch(() => {})}
            />
            <main className={`summary-editor-workspace mode-${mode}`}>
              {mode !== "preview" && (
                <section className="summary-editor-pane" aria-label="Markdown bearbeiten">
                  <MarkdownEditor value={draft} onChange={setDraft} onSave={() => void save()} />
                </section>
              )}
              {mode !== "edit" && (
                <section className="summary-preview-pane" aria-label="A4-Vorschau">
                  <A4Preview content={draft} title={recordingTitle} />
                </section>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
