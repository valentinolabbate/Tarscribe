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
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 16 }}>
      <div style={{ textAlign: "center", paddingTop: 4 }}>
        <div className="big" style={{ fontSize: 23 }}>
          Willkommen bei Tarscribe
        </div>
        <div style={{ color: "var(--text-faint)", marginTop: 4 }}>
          Durchsuche deine Aufnahmen semantisch — oder starte einen Wissens-Chat.
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel topics={topics} onOpenSource={onOpenSource} />
      </div>
    </div>
  );
}
