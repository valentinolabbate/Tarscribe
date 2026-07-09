import type { RefObject } from "react";
import type { PlayerHandle } from "../AudioPlayer";
import type { Recording, Topic } from "../../lib/types";
import { ChatPanel } from "../ChatPanel";
import { DocumentsPanel } from "../DocumentsPanel";
import { ChatIcon } from "../icons";

export function AskWorkspace({
  topics,
  recording,
  playerRef,
  onOpenDocument,
}: {
  topics: Topic[];
  recording: Recording;
  playerRef: RefObject<PlayerHandle | null>;
  onOpenDocument: (documentId: number) => void;
}) {
  return (
    <section className="detail-panel ask-workspace">
      <div className="detail-panel-head">
        <div>
          <h2>Chat & Suche</h2>
          <p>Stelle Fragen direkt an diese Aufnahme oder finde Belegstellen im Transkript.</p>
        </div>
        <ChatIcon width={20} height={20} />
      </div>
      <ChatPanel
        embedded
        topics={topics}
        scopeRecording={{ id: recording.id, title: recording.title }}
        onOpenSource={(recordingId, start) => {
          if (recordingId === recording.id) playerRef.current?.seek(start ?? 0);
        }}
        onOpenDocument={onOpenDocument}
      />
      <DocumentsPanel
        compact
        topicId={recording.topic_id}
        recordingId={recording.id}
        onOpenDocument={onOpenDocument}
      />
    </section>
  );
}
