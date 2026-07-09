import { useState } from "react";
import type { SummarySource } from "../lib/types";
import { SourceAction } from "./chat-panel/SourceAction";

const VISIBLE_LIMIT = 5;

function parseSources(raw: string | null): SummarySource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SummarySource[]) : [];
  } catch {
    return [];
  }
}

function sourceTypeLabel(t: SummarySource["source_type"]): string {
  if (t === "document") return "Datei";
  if (t === "summary") return "Zusammenfassung";
  if (t === "web") return "Web";
  return "Transkript";
}

function sourceTitle(s: SummarySource): string {
  if (s.source_type === "web" && s.source_url) {
    try {
      return new URL(s.source_url).hostname.replace(/^www\./, "");
    } catch {
      return s.source_url;
    }
  }
  return s.recording_title || "Quelle";
}

export function SummarySourcesPanel({
  raw,
  onOpenSource,
  onOpenDocument,
}: {
  raw: string | null;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
}) {
  const sources = parseSources(raw);
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;

  const webCount = sources.filter((s) => s.source_type === "web").length;
  const kbCount = sources.length - webCount;
  const visible = expanded ? sources : sources.slice(0, VISIBLE_LIMIT);
  const hidden = sources.length - visible.length;

  return (
    <div className="summary-sources-panel">
      <div className="summary-sources-head">
        <span className="summary-sources-title">
          Quellen · {sources.length}
        </span>
        <span className="summary-sources-breakdown">
          {webCount > 0 && `${webCount} Web`}
          {webCount > 0 && kbCount > 0 && " · "}
          {kbCount > 0 && `${kbCount} Wissensbasis`}
        </span>
      </div>
      <div className="summary-sources-list">
        {visible.map((s) => (
          <div className="summary-source-row" key={s.index}>
            <span className="summary-source-label">
              <span className="summary-source-index">[{s.index}]</span>
              <span className="summary-source-name" title={sourceTitle(s)}>
                {sourceTitle(s)}
              </span>
              <span className="summary-source-type">{sourceTypeLabel(s.source_type)}</span>
            </span>
            <SourceAction
              source={s}
              scoped={false}
              onOpenSource={onOpenSource}
              onOpenDocument={onOpenDocument}
            />
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="summary-sources-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Quellen einklappen" : `Alle ${sources.length} Quellen anzeigen`}
        </button>
      )}
    </div>
  );
}
