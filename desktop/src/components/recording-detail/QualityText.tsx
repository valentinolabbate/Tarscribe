import { Fragment, useEffect, useRef } from "react";
import type { QualityIssue, WordSeg } from "../../lib/types";

export function QualityText({
  words,
  issues,
  onSelect,
  onAcknowledge,
  selectedId = null,
}: {
  words: WordSeg[];
  issues: QualityIssue[];
  onSelect: (issue: QualityIssue) => void;
  onAcknowledge: (issue: QualityIssue) => void;
  selectedId?: string | null;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const issueByIndex = new Map(issues.map((issue) => [issue.start_word_idx, issue]));
  const selectedSourceIndex = issues.find((issue) => issue.issue_id === selectedId)?.start_word_idx;
  const selectedIsRendered = selectedSourceIndex != null && words.some(
    (word, index) => (word.source_start_idx ?? index) === selectedSourceIndex,
  );

  useEffect(() => {
    if (selectedIsRendered) {
      selectedRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedId, selectedIsRendered]);

  return (
    <>
      {words.map((word, index) => {
        const sourceIndex = word.source_start_idx ?? index;
        const issue = issueByIndex.get(sourceIndex);
        if (!issue) return <span key={`${sourceIndex}-${index}`}>{word.text}</span>;
        const leadingWhitespace = word.text.match(/^\s+/u)?.[0] ?? "";
        const selected = issue.issue_id === selectedId;
        const confidence = issue.min_confidence == null ? "" : `, ${Math.round(issue.min_confidence * 100)} % Konfidenz`;
        return (
          <Fragment key={`${sourceIndex}-${index}`}>
            {leadingWhitespace}
            <button
              ref={selected ? selectedRef : undefined}
              className={`quality-word quality-word-${issue.severity}${selected ? " selected" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(issue);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onAcknowledge(issue);
              }}
              aria-label={`${issue.raw_text.trim()}: prüfen, mit Doppelklick als korrekt bestätigen${confidence}`}
              aria-pressed={selected}
              title={`Prüfen: ${issue.raw_text.trim()}${confidence} · Doppelklick: stimmt`}
            >
              {word.text.slice(leadingWhitespace.length)}
            </button>
          </Fragment>
        );
      })}
    </>
  );
}
