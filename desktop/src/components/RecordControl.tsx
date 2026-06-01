import { useEffect, useRef, useState } from "react";
import { useUploadRecording } from "../hooks/queries";
import { useToast } from "./Toast";
import { Recorder, recordingExtension } from "../lib/recorder";
import { MicIcon, StopIcon } from "./icons";

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function RecordControl({ topicId }: { topicId: number }) {
  const upload = useUploadRecording();
  const toast = useToast();
  const recorder = useRef<Recorder | null>(null);
  const [state, setState] = useState<"idle" | "recording" | "paused" | "saving">("idle");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (state !== "recording") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => () => recorder.current?.dispose(), []);

  async function start() {
    try {
      recorder.current = new Recorder();
      await recorder.current.start();
      setElapsed(0);
      setState("recording");
    } catch (e) {
      toast(`Mikrofon nicht verfügbar: ${(e as Error).message}`, "error");
      recorder.current = null;
    }
  }

  async function stop() {
    if (!recorder.current) return;
    setState("saving");
    const mime = recorder.current.mimeType;
    let blob: Blob;
    try {
      blob = await recorder.current.stop();
    } catch (e) {
      toast(`Aufnahme fehlgeschlagen: ${(e as Error).message}`, "error");
      recorder.current = null;
      setState("idle");
      setElapsed(0);
      return;
    }
    recorder.current = null;
    const stamp = new Date().toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const ext = recordingExtension(mime);
    const file = new File([blob], `aufnahme.${ext}`, { type: mime });
    try {
      await upload.mutateAsync({ topicId, file, title: `Aufnahme ${stamp}` });
      toast("Aufnahme gespeichert", "success");
    } catch (e) {
      toast(`Speichern fehlgeschlagen: ${(e as Error).message}`, "error");
    }
    setState("idle");
    setElapsed(0);
  }

  function togglePause() {
    if (!recorder.current) return;
    if (state === "recording") {
      recorder.current.pause();
      setState("paused");
    } else {
      recorder.current.resume();
      setState("recording");
    }
  }

  if (state === "idle") {
    return (
      <button className="btn" onClick={start}>
        <MicIcon width={16} height={16} /> Aufnehmen
      </button>
    );
  }

  return (
    <div className="rec-live">
      {state !== "saving" && <span className={`rec-pulse ${state}`} />}
      <span className="rec-elapsed">{state === "saving" ? "Speichere…" : fmt(elapsed)}</span>
      {state !== "saving" && (
        <>
          <button className="btn ghost" onClick={togglePause}>
            {state === "paused" ? "Fortsetzen" : "Pause"}
          </button>
          <button className="btn primary" onClick={stop}>
            <StopIcon width={14} height={14} /> Stopp
          </button>
        </>
      )}
    </div>
  );
}
