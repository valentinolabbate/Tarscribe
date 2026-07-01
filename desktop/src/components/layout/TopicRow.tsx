import { useState } from "react";
import { useDeleteTopic, useUpdateTopic } from "../../hooks/queries";
import { useRecording } from "../../hooks/useRecording";
import type { Topic } from "../../lib/types";
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from "../icons";

export function TopicRow({
  topic,
  active,
  canMoveUp,
  canMoveDown,
  onSelect,
  onMoveUp,
  onMoveDown,
}: {
  topic: Topic;
  active: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateTopic();
  const del = useDeleteTopic();
  const recording = useRecording();
  const artifactBadges = [
    {
      key: "transcribed",
      label: "T",
      count: topic.transcribed_count,
      title: `${topic.transcribed_count} transkribiert`,
    },
    {
      key: "diarized",
      label: "D",
      count: topic.diarized_count,
      title: `${topic.diarized_count} mit Sprechererkennung`,
    },
    {
      key: "exported",
      label: "E",
      count: topic.exported_count,
      title: `${topic.exported_count} exportiert`,
    },
  ].filter((item) => item.count > 0);

  if (editing) {
    return (
      <input
        className="topic-edit"
        defaultValue={topic.name}
        autoFocus
        onBlur={(event) => {
          const value = event.target.value.trim();
          if (value && value !== topic.name) update.mutate({ id: topic.id, patch: { name: value } });
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <div
      className={`topic-item topic-row ${active ? "active" : ""}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      title="Doppelklick zum Umbenennen"
    >
      <span className="topic-dot" style={{ background: topic.color }} />
      <span className="topic-name">{topic.name}</span>
      {artifactBadges.length > 0 && (
        <span className="topic-artifacts" aria-label="Verarbeitungsstatus">
          {artifactBadges.map((item) => (
            <span key={item.key} className={`topic-artifact ${item.key}`} title={item.title}>
              {item.label}
              {item.count}
            </span>
          ))}
        </span>
      )}
      <span className="topic-actions">
        <span className="topic-reorder" aria-label="Sortieren">
          <button
            className="topic-move"
            title="Nach oben"
            aria-label="Nach oben verschieben"
            disabled={!canMoveUp}
            onClick={(event) => {
              event.stopPropagation();
              onMoveUp();
            }}
          >
            <ChevronUpIcon width={13} height={13} />
          </button>
          <button
            className="topic-move"
            title="Nach unten"
            aria-label="Nach unten verschieben"
            disabled={!canMoveDown}
            onClick={(event) => {
              event.stopPropagation();
              onMoveDown();
            }}
          >
            <ChevronDownIcon width={13} height={13} />
          </button>
        </span>
        <button
          className="topic-del"
          title={
            recording.topicId === topic.id
              ? "Während einer laufenden Aufnahme nicht löschbar"
              : "Themenbereich löschen"
          }
          disabled={recording.topicId === topic.id}
          onClick={(event) => {
            event.stopPropagation();
            del.mutate(topic.id);
          }}
        >
          <TrashIcon width={13} height={13} />
        </button>
      </span>
    </div>
  );
}
