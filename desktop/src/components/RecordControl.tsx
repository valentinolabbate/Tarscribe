import { useRecording } from "../hooks/useRecording";
import { MicIcon } from "./icons";

export function RecordControl({ topicId, topicName }: { topicId: number; topicName: string }) {
  const recording = useRecording();

  return (
    <button
      className="btn"
      disabled={recording.state !== "idle"}
      onClick={() => recording.start(topicId, topicName)}
    >
      <MicIcon width={16} height={16} />
      {recording.state === "idle" ? "Aufnehmen" : "Aufnahme läuft"}
    </button>
  );
}
