import type { RagHit, RagSource, Topic } from "../../lib/types";
import { EvidenceTrail } from "../EvidenceTrail";
import { sourceTypeLabel } from "./model";
import { SourceAction } from "./SourceAction";

function sourceTitle(source: RagHit | RagSource): string {
  if (source.source_type === "web" && source.source_url) {
    try {
      return new URL(source.source_url).hostname.replace(/^www\./, "");
    } catch {
      return source.source_url;
    }
  }
  return source.recording_title || sourceTypeLabel(source.source_type);
}

function positionLabel(source: RagHit | RagSource): string | null {
  if (source.start_sec != null) return null;
  if (source.source_type === "document") return "Dok.";
  if (source.source_type === "summary") return "Zus.";
  if (source.source_type === "web") return "Web";
  return null;
}

export function RagEvidenceTrail({
  source,
  topics,
  scoped,
  onOpenSource,
  onOpenDocument,
}: {
  source: RagHit | RagSource;
  topics: Topic[];
  scoped: boolean;
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
}) {
  const topic = topics.find((candidate) => candidate.id === source.topic_id);

  return (
    <div className="rag-evidence-trail">
      <EvidenceTrail
        recordingId={source.recording_id}
        recordingTitle={sourceTitle(source)}
        startSec={source.start_sec}
        positionLabel={positionLabel(source)}
        sourceType={sourceTypeLabel(source.source_type)}
        quote={source.text}
        topicName={topic?.name}
        topicColor={topic?.color}
        speaker={source.speaker}
      />
      <div className="rag-evidence-action">
        <SourceAction
          source={source}
          scoped={scoped}
          onOpenSource={onOpenSource}
          onOpenDocument={onOpenDocument}
        />
      </div>
    </div>
  );
}
