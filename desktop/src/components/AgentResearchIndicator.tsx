import type { AgentResearchState } from "../hooks/useJobs";

export function AgentResearchIndicator({ research }: { research: AgentResearchState }) {
  if (research.done) return null;
  return (
    <div className="agent-research-indicator">
      <div className="agent-research-header">
        <div className="spinner-sm" />
        <span>Recherchiert Kontext in der Wissensbasis…</span>
        <span className="agent-research-round">
          Runde {Math.max(0, ...research.queries.map((q) => q.round)) + 1}
        </span>
      </div>
      {research.queries.length > 0 && (
        <div className="agent-research-queries">
          {research.queries.map((q, i) => (
            <div key={i} className="agent-research-query">
              <span className="agent-research-query-text">{q.query || "…"}</span>
              <span className="agent-research-query-meta">
                {q.scope} · {q.hits > 0 ? `${q.hits} Treffer` : "…"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentResearchDoneBadge({ sources }: { sources: number }) {
  return (
    <div className="agent-research-summary">
      <span className="badge ready">
        Recherche abgeschlossen · {sources} Quelle{sources === 1 ? "" : "n"}
      </span>
    </div>
  );
}
