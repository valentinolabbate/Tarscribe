import { useRecording } from "../hooks/useRecording";
import { MicIcon } from "./icons";

export function RecordControl({
  topicId,
  topicName,
  primary = false,
}: {
  topicId: number;
  topicName: string;
  primary?: boolean;
}) {
  const recording = useRecording();

  return (
    <button
      className={primary ? "btn primary record-btn" : "btn record-btn"}
      disabled={recording.state !== "idle"}
      onClick={() => recording.start(topicId, topicName)}
    >
      <MicIcon width={16} height={16} />
      {recording.state === "idle" ? "Aufnehmen" : "Aufnahme läuft"}
    </button>
  );
}
