import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/Toast";
import { api } from "../lib/api";
import { Recorder, recordingExtension } from "../lib/recorder";

type RecordingState = "idle" | "starting" | "recording" | "paused" | "saving";

interface RecordingContextValue {
  state: RecordingState;
  elapsed: number;
  topicId: number | null;
  topicName: string | null;
  start: (topicId: number, topicName: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const recorder = useRef<Recorder | null>(null);
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [topicId, setTopicId] = useState<number | null>(null);
  const [topicName, setTopicName] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => () => recorder.current?.dispose(), []);

  const reset = useCallback(() => {
    recorder.current = null;
    setState("idle");
    setElapsed(0);
    setTopicId(null);
    setTopicName(null);
  }, []);

  const start = useCallback(
    async (nextTopicId: number, nextTopicName: string) => {
      if (recorder.current || state !== "idle") return;
      const next = new Recorder();
      recorder.current = next;
      setState("starting");
      try {
        const settings = await api.getSettings();
        const usedFallback = await next.start(settings.recording_device_id);
        setTopicId(nextTopicId);
        setTopicName(nextTopicName);
        setElapsed(0);
        setState("recording");
        if (usedFallback) {
          toast("Das gewählte Mikrofon ist nicht verfügbar. Verwende das Systemstandardgerät.", "info");
        }
      } catch (e) {
        next.dispose();
        reset();
        toast(`Mikrofon nicht verfügbar: ${(e as Error).message}`, "error");
      }
    },
    [reset, state, toast],
  );

  const pause = useCallback(() => {
    recorder.current?.pause();
    setState("paused");
  }, []);

  const resume = useCallback(() => {
    recorder.current?.resume();
    setState("recording");
  }, []);

  const stop = useCallback(async () => {
    const current = recorder.current;
    if (!current || topicId == null) return;
    setState("saving");
    const mime = current.mimeType;
    try {
      const blob = await current.stop();
      const stamp = new Date().toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const ext = recordingExtension(mime);
      const file = new File([blob], `aufnahme.${ext}`, { type: mime });
      await api.uploadRecording(topicId, file, `Aufnahme ${stamp}`);
      await queryClient.invalidateQueries({ queryKey: ["recordings", topicId] });
      toast("Aufnahme gespeichert", "success");
    } catch (e) {
      toast(`Aufnahme fehlgeschlagen: ${(e as Error).message}`, "error");
    } finally {
      current.dispose();
      reset();
    }
  }, [queryClient, reset, toast, topicId]);

  return (
    <RecordingContext.Provider
      value={{ state, elapsed, topicId, topicName, start, pause, resume, stop }}
    >
      {children}
    </RecordingContext.Provider>
  );
}

export function useRecording(): RecordingContextValue {
  const value = useContext(RecordingContext);
  if (!value) throw new Error("useRecording muss innerhalb des RecordingProvider verwendet werden.");
  return value;
}
