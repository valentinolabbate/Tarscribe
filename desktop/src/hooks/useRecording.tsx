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
import { LivePcmCapture, SystemAudioPcmCapture } from "../lib/livePcmCapture";
import {
  NativeSystemAudioRecorder,
  SystemAudioAndMicrophoneRecorder,
  pollSystemAudioPcm,
  systemAudioSampleRate,
} from "../lib/nativeSystemAudioRecorder";
import { Recorder, errorMessage, recordingExtension } from "../lib/recorder";
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
  const pcmCapture = useRef<LivePcmCapture | SystemAudioPcmCapture | null>(null);
  const elapsedBase = useRef(0);
  const elapsedStartedAt = useRef<number | null>(null);
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [topicId, setTopicId] = useState<number | null>(null);
  const [topicName, setTopicName] = useState<string | null>(null);
  const [lastFinishedRecording, setLastFinishedRecording] = useState<Recording | null>(null);
  const clearLastFinished = useCallback(() => setLastFinishedRecording(null), []);

  const { startSession, enqueueChunk, handle: liveHandle } = useLiveRecording();

  const computeElapsed = useCallback(() => {
    if (elapsedStartedAt.current == null) return elapsedBase.current;
    const seconds = elapsedBase.current + Math.floor((Date.now() - elapsedStartedAt.current) / 1000);
    return Math.max(0, seconds);
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const tick = () => setElapsed(computeElapsed());
    tick();
    const timer = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [state, computeElapsed]);

  useEffect(() => () => {
    recorder.current?.dispose();
    pcmCapture.current?.stop();
  }, []);

  const reset = useCallback(() => {
    recorder.current = null;
    pcmCapture.current?.stop();
    pcmCapture.current = null;
    elapsedBase.current = 0;
    elapsedStartedAt.current = null;
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
        elapsedBase.current = 0;
        elapsedStartedAt.current = Date.now();
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
        const sessionId = await startSession(nextTopicId, sessionTitle);
        if (sessionId) {
          try {
            if (next.audioStream) {
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
            } else if (next instanceof NativeSystemAudioRecorder) {
              const capture = new SystemAudioPcmCapture();
              pcmCapture.current = capture;
              await capture.start({
                onChunk: (chunk, _seq) => enqueueChunk(chunk),
                systemAudio: { poll: pollSystemAudioPcm, sampleRate: systemAudioSampleRate },
              });
            }
          } catch (e) {
            console.warn("[live] PCM capture init failed:", e);
            // Live preview unavailable, archive recording continues.
          }
        }
      } catch (e) {
        next?.dispose();
        reset();
        toast(`Aufnahme nicht verfügbar: ${errorMessage(e)}`, "error");
      }
    },
    [reset, state, toast, startSession, enqueueChunk],
  );

  const pause = useCallback(() => {
    recorder.current?.pause();
    pcmCapture.current?.pause();
    liveHandle?.notifyPause();
    const nextElapsed = computeElapsed();
    elapsedBase.current = nextElapsed;
    elapsedStartedAt.current = null;
    setElapsed(nextElapsed);
    setState("paused");
  }, [computeElapsed, liveHandle]);

  const resume = useCallback(() => {
    recorder.current?.resume();
    pcmCapture.current?.resume();
    liveHandle?.notifyResume();
    elapsedStartedAt.current = Date.now();
    setState("recording");
  }, [liveHandle]);

  const stop = useCallback(async () => {
    const current = recorder.current;
    if (!current || topicId == null) return;
    const nextElapsed = computeElapsed();
    elapsedBase.current = nextElapsed;
    elapsedStartedAt.current = null;
    setElapsed(nextElapsed);
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
      toast(`Aufnahme fehlgeschlagen: ${errorMessage(e)}`, "error");
      await liveHandle?.cancel();
    } finally {
      current.dispose();
      reset();
    }
  }, [computeElapsed, queryClient, reset, toast, topicId, liveHandle]);

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
