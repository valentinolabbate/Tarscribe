import { ChatPanel } from "./ChatPanel";
import type { Topic } from "../lib/types";

/**
 * Landing page: semantic search over all recordings (no LLM required) plus a
 * message bar to start a knowledge chat. The underlying panel toggles between
 * "Suche" and "Chat"; it defaults to search so it is useful without a chat LLM.
 */
export function StartPage({
  topics,
  onOpenSource,
}: {
  topics: Topic[];
  onOpenSource: (recordingId: number, startSec?: number | null) => void;
}) {
  const recordingCount = topics.reduce((sum, topic) => sum + topic.recording_count, 0);
  const transcribedCount = topics.reduce((sum, topic) => sum + topic.transcribed_count, 0);
  const diarizedCount = topics.reduce((sum, topic) => sum + topic.diarized_count, 0);

  return (
    <div className="start-page">
      <header className="start-hero">
        <div>
          <span className="page-kicker">Start</span>
          <h2>Finde jede Stelle in deinen Aufnahmen</h2>
          <p>Semantische Suche funktioniert lokal über Transkripte und Zusammenfassungen. Wenn ein Chat-Modell konfiguriert ist, kannst du direkt Fragen stellen.</p>
        </div>
        <div className="start-stats">
          <div>
            <strong>{recordingCount}</strong>
            <span>Aufnahmen</span>
          </div>
          <div>
            <strong>{transcribedCount}</strong>
            <span>Transkribiert</span>
          </div>
          <div>
            <strong>{diarizedCount}</strong>
            <span>Sprecher</span>
          </div>
        </div>
      </header>
      <section className="start-search">
        <ChatPanel topics={topics} onOpenSource={onOpenSource} />
      </section>
    </div>
  );
}
