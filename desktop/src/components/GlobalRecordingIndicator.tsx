import { useRecording } from "../hooks/useRecording";
import { fmtDuration } from "../lib/format";
import { StopIcon } from "./icons";

export function GlobalRecordingIndicator() {
  const recording = useRecording();
  if (recording.state === "idle") return null;

  const active = recording.state === "recording" || recording.state === "paused";
  return (
    <div className="global-recorder">
      {active && <span className={`rec-pulse ${recording.state}`} />}
      <span className="global-recorder-topic">{recording.topicName ?? "Aufnahme"}</span>
      <span className="rec-elapsed">
        {recording.state === "starting"
          ? "Startet..."
          : recording.state === "saving"
            ? "Speichert..."
            : fmtDuration(recording.elapsed)}
      </span>
      {active && (
        <>
          <button
            className="btn ghost"
            onClick={recording.state === "paused" ? recording.resume : recording.pause}
          >
            {recording.state === "paused" ? "Fortsetzen" : "Pause"}
          </button>
          <button className="btn ghost danger" title="Aufnahme stoppen" onClick={recording.stop}>
            <StopIcon width={14} height={14} />
          </button>
        </>
      )}
    </div>
  );
}
