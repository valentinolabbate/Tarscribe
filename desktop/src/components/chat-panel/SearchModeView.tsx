import type { RagHit, Topic } from "../../lib/types";
import { SearchIcon } from "../icons";
import { RagEvidenceTrail } from "./RagEvidenceTrail";

export function SearchModeView({
  hits,
  searching,
  ragOff,
  scoped,
  topics,
  prompts,
  onPrompt,
  onOpenSource,
  onOpenDocument,
}: {
  hits: RagHit[] | null;
  searching: boolean;
  ragOff: boolean;
  scoped: boolean;
  topics: Topic[];
  prompts: string[];
  onPrompt: (prompt: string) => void;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
}) {
  return (
    <>
      {hits === null && !searching && !ragOff && (
        <div className="empty" style={{ margin: "auto", textAlign: "center" }}>
          <SearchIcon width={28} height={28} />
          <div className="big" style={{ marginTop: 8 }}>
            {scoped ? "Im Transkript suchen" : "Was möchtest du finden?"}
          </div>
          <div style={{ color: "var(--text-faint)", maxWidth: 420 }}>
            {scoped ? "Durchsucht diese Aufnahme nach passenden Stellen." : "Durchsucht Transkripte und Zusammenfassungen."}
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
          <span className="chat-result-rank">#{index + 1}</span>
          <RagEvidenceTrail
            source={hit}
            topics={topics}
            scoped={scoped}
            onOpenSource={onOpenSource}
            onOpenDocument={onOpenDocument}
          />
        </div>
      ))}
    </>
  );
}
