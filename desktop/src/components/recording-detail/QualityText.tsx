import type { QualityIssue, WordSeg } from "../../lib/types";

export function QualityText({
  words,
  issues,
  onSelect,
}: {
  words: WordSeg[];
  issues: QualityIssue[];
  onSelect: (issue: QualityIssue) => void;
}) {
  const issueByIndex = new Map(issues.map((issue) => [issue.start_word_idx, issue]));
  return (
    <>
      {words.map((word, index) => {
        const sourceIndex = word.source_start_idx ?? index;
        const issue = issueByIndex.get(sourceIndex);
        if (!issue) return <span key={`${sourceIndex}-${index}`}>{word.text}</span>;
        const confidence = issue.min_confidence == null ? "" : `, ${Math.round(issue.min_confidence * 100)} % Konfidenz`;
        return (
          <button
            className={`quality-word quality-${issue.severity}`}
            key={`${sourceIndex}-${index}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(issue);
            }}
            aria-label={`${issue.raw_text.trim()}: prüfen${confidence}`}
            title={`Prüfen: ${issue.raw_text.trim()}${confidence}`}
          >
            {word.text}
          </button>
        );
      })}
    </>
  );
}
