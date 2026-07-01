import type { RagSource, Topic } from "../../lib/types";
import { buildContextChips } from "./model";

export function ChatContextUsage({
  sources,
  topics,
  scopeRecording,
}: {
  sources: RagSource[];
  topics: Topic[];
  scopeRecording?: { id: number; title: string };
}) {
  const chips = buildContextChips(sources, topics, scopeRecording);
  return (
    <div className="chat-context-usage" aria-label="Genutzter Antwortkontext">
      <span className="chat-context-label">Diese Antwort nutzt:</span>
      {chips.length > 0 ? (
        chips.map((chip) => (
          <span key={chip.label} className="chat-context-chip" title={chip.title}>
            {chip.label}
          </span>
        ))
      ) : (
        <span className="chat-context-empty">keine passenden Quellen</span>
      )}
    </div>
  );
}
