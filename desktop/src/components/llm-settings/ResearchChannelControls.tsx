import { LinkIcon, SearchIcon } from "../icons";

export function ResearchChannelControls({
  knowledgeEnabled,
  webEnabled,
  onKnowledgeChange,
  onWebChange,
  profileLabel,
}: {
  knowledgeEnabled: boolean;
  webEnabled: boolean;
  onKnowledgeChange: (enabled: boolean) => void;
  onWebChange: (enabled: boolean) => void;
  profileLabel: string;
}) {
  const activeCount = Number(knowledgeEnabled) + Number(webEnabled);

  return (
    <div className="llm-research-strip" role="group" aria-label={`Recherche für ${profileLabel}`}>
      <div className="llm-research-meta" aria-hidden="true">
        <span>Recherche</span>
        <strong>{activeCount ? `${activeCount}/2` : "Aus"}</strong>
      </div>
      <label
        className={
          knowledgeEnabled
            ? "llm-research-option knowledge active"
            : "llm-research-option knowledge"
        }
        title="Interne Aufnahmen, Zusammenfassungen und Dokumente durchsuchen"
      >
        <input
          type="checkbox"
          checked={knowledgeEnabled}
          aria-label={`Wissensrecherche für ${profileLabel}`}
          onChange={(event) => onKnowledgeChange(event.target.checked)}
        />
        <span className="llm-research-option-icon" aria-hidden="true">
          <SearchIcon width={13} height={13} />
        </span>
        <span>Wissen</span>
      </label>
      <label
        className={webEnabled ? "llm-research-option web active" : "llm-research-option web"}
        title="Aktuelle und externe Quellen im Web durchsuchen"
      >
        <input
          type="checkbox"
          checked={webEnabled}
          aria-label={`Webrecherche für ${profileLabel}`}
          onChange={(event) => onWebChange(event.target.checked)}
        />
        <span className="llm-research-option-icon" aria-hidden="true">
          <LinkIcon width={13} height={13} />
        </span>
        <span>Web</span>
      </label>
    </div>
  );
}
