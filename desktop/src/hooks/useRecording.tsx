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
import { LivePcmCapture } from "../lib/livePcmCapture";
import {
  NativeSystemAudioRecorder,
  SystemAudioAndMicrophoneRecorder,
  pollSystemAudioPcm,
  systemAudioSampleRate,
} from "../lib/nativeSystemAudioRecorder";
import { Recorder, recordingExtension } from "../lib/recorder";
import { useLiveRecording, type LiveRecordingHandle } from "./useLiveRecording";
import type { LiveEvent, Recording } from "../lib/types";

type RecordingState = "idle" | "starting" | "recording" | "paused" | "saving";

interface RecordingContextValue {
  state: RecordingState;
  elapsed: number;
  topicId: number | null;
  topicName: string | null;
  liveHandle: LiveRecordingHandle | null;
  /** Set after a successful stop — App.tsx uses this to auto-open the recording detail. */
  lastFinishedRecording: Recording | null;
  clearLastFinished: () => void;
  start: (topicId: number, topicName: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  /** Feed WebSocket live events into the active live session. */
  dispatchLiveEvent: (e: LiveEvent) => void;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const recorder = useRef<Recorder | NativeSystemAudioRecorder | SystemAudioAndMicrophoneRecorder | null>(null);
  const pcmCapture = useRef<LivePcmCapture | null>(null);
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [topicId, setTopicId] = useState<number | null>(null);
  const [topicName, setTopicName] = useState<string | null>(null);
  const [lastFinishedRecording, setLastFinishedRecording] = useState<Recording | null>(null);
  const clearLastFinished = useCallback(() => setLastFinishedRecording(null), []);

  const { startSession, enqueueChunk, handle: liveHandle } = useLiveRecording();

  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => () => {
    recorder.current?.dispose();
    pcmCapture.current?.stop();
  }, []);

  const reset = useCallback(() => {
    recorder.current = null;
    pcmCapture.current?.stop();
    pcmCapture.current = null;
    setState("idle");
    setElapsed(0);
    setTopicId(null);
    setTopicName(null);
  }, []);

  const start = useCallback(
    async (nextTopicId: number, nextTopicName: string) => {
      if (recorder.current || state !== "idle") return;
      setState("starting");
      let next: Recorder | NativeSystemAudioRecorder | SystemAudioAndMicrophoneRecorder | null = null;
      try {
        const settings = await api.getSettings();
        next = settings.recording_source === "system_audio"
          ? new NativeSystemAudioRecorder()
          : settings.recording_source === "system_audio_and_microphone"
            ? new SystemAudioAndMicrophoneRecorder()
            : new Recorder();
        recorder.current = next;
        const usedFallback = await next.start(settings.recording_device_id);
        setTopicId(nextTopicId);
        setTopicName(nextTopicName);
        setElapsed(0);
        setState("recording");
        if (usedFallback) {
          toast("Das gewählte Mikrofon ist nicht verfügbar. Verwende das Systemstandardgerät.", "info");
        }

        // Start live session in background — failure must not affect archive recording.
        const stamp = new Date().toLocaleString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        const sessionTitle = `Aufnahme ${stamp}`;
        if (next.audioStream) {
          const sessionId = await startSession(nextTopicId, sessionTitle);
          if (!sessionId) return;
          try {
            const capture = new LivePcmCapture();
            pcmCapture.current = capture;
            await capture.start({
              stream: next.audioStream,
              onChunk: (chunk, _seq) => enqueueChunk(chunk),
              // Bundled recordings must feed every source into the live preview:
              // mix the native system-audio tap in alongside the microphone.
              systemAudio: next instanceof SystemAudioAndMicrophoneRecorder
                ? { poll: pollSystemAudioPcm, sampleRate: systemAudioSampleRate }
                : undefined,
            });
          } catch (e) {
            console.warn("[live] PCM capture init failed:", e);
            // Live preview unavailable, archive recording continues.
          }
        } else {
          toast("Systemaudio wird aufgenommen. Die Live-Vorschau folgt in einem weiteren Schritt.", "info");
        }
      } catch (e) {
        next?.dispose();
        reset();
        toast(`Aufnahme nicht verfügbar: ${(e as Error).message}`, "error");
      }
    },
    [reset, state, toast, startSession, enqueueChunk],
  );

  const pause = useCallback(() => {
    recorder.current?.pause();
    pcmCapture.current?.pause();
    liveHandle?.notifyPause();
    setState("paused");
  }, [liveHandle]);

  const resume = useCallback(() => {
    recorder.current?.resume();
    pcmCapture.current?.resume();
    liveHandle?.notifyResume();
    setState("recording");
  }, [liveHandle]);

  const stop = useCallback(async () => {
    const current = recorder.current;
    if (!current || topicId == null) return;
    setState("saving");

    // Stop PCM capture immediately.
    pcmCapture.current?.stop();
    pcmCapture.current = null;

    try {
      const output = await current.stop();
      const stamp = new Date().toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const recording = output instanceof Blob
        ? await api.uploadRecording(
            topicId,
            new File([output], `aufnahme.${recordingExtension(current.mimeType)}`, { type: current.mimeType }),
            `Aufnahme ${stamp}`,
          )
        : "microphoneBlob" in output && output.microphoneBlob instanceof Blob
          ? await api.importMixedLocalRecording(topicId, output.path, output.microphoneBlob, `Aufnahme ${stamp}`)
        : await api.importLocalRecording(topicId, output.path, `Aufnahme ${stamp}`);
      await queryClient.invalidateQueries({ queryKey: ["recordings", topicId] });
      await liveHandle?.finish(recording.id ?? null);
      setLastFinishedRecording(recording);
      toast("Aufnahme gespeichert", "success");
    } catch (e) {
      toast(`Aufnahme fehlgeschlagen: ${(e as Error).message}`, "error");
      await liveHandle?.cancel();
    } finally {
      current.dispose();
      reset();
    }
  }, [queryClient, reset, toast, topicId, liveHandle]);

  const dispatchLiveEvent = useCallback(
    (e: LiveEvent) => liveHandle?.onLiveEvent(e),
    [liveHandle],
  );

  return (
    <RecordingContext.Provider
      value={{
        state, elapsed, topicId, topicName, liveHandle,
        lastFinishedRecording, clearLastFinished,
        start, pause, resume, stop, dispatchLiveEvent,
      }}
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
