import type { RagHit } from "../../lib/types";
import { SearchIcon } from "../icons";
import { sourceMeta } from "./model";
import { SourceAction } from "./SourceAction";

export function SearchModeView({
  hits,
  searching,
  ragOff,
  scoped,
  prompts,
  onPrompt,
  onOpenSource,
}: {
  hits: RagHit[] | null;
  searching: boolean;
  ragOff: boolean;
  scoped: boolean;
  prompts: string[];
  onPrompt: (prompt: string) => void;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
}) {
  return (
    <>
      {hits === null && !searching && !ragOff && (
        <div className="empty" style={{ margin: "auto", textAlign: "center" }}>
          <SearchIcon width={28} height={28} />
          <div className="big" style={{ marginTop: 8 }}>
            {scoped ? "Aufnahme durchsuchen" : "Aufnahmen durchsuchen"}
          </div>
          <div style={{ color: "var(--text-faint)", maxWidth: 420 }}>
            Semantische Suche über {scoped ? "diese Aufnahme" : "alle Transkripte und Zusammenfassungen"}.
            Findet passende Stellen auch ohne exakte Wortgleichheit — kein LLM nötig.
          </div>
          <div className="empty-action-row" aria-label="Suchbeispiele">
            {prompts.map((prompt) => (
              <button className="btn ghost" key={prompt} onClick={() => onPrompt(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
      {searching && <div style={{ color: "var(--text-faint)", margin: "auto" }}>Suche…</div>}
      {hits?.length === 0 && (
        <div style={{ color: "var(--text-faint)", margin: "auto" }}>Keine Treffer gefunden.</div>
      )}
      {hits?.map((hit, index) => (
        <div key={hit.chunk_id} className="chat-result-card">
          <div className="chat-result-meta">
            <span style={{ fontWeight: 600, color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>
              #{index + 1}
            </span>
            <span>{sourceMeta(hit, !scoped)}</span>
            <div style={{ flex: 1 }} />
            <SourceAction source={hit} scoped={scoped} onOpenSource={onOpenSource} />
          </div>
          <div className="chat-result-text">{hit.text}</div>
        </div>
      ))}
    </>
  );
}
