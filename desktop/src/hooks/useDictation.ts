import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/Toast";
import { api } from "../lib/api";
import { fmtDuration } from "../lib/format";
import { Recorder, errorMessage, recordingExtension } from "../lib/recorder";
import { trackPendingJob } from "./useJobs";

export type DictationState = "idle" | "starting" | "recording" | "saving";

export interface DictationController {
  state: DictationState;
  elapsed: number;
  elapsedLabel: string;
  start: () => Promise<void>;
  stopAndSave: () => Promise<void>;
  discard: () => void;
  toggle: () => Promise<void>;
}

export function useDictation(onOpenRecording: (recordingId: number) => void): DictationController {
  const queryClient = useQueryClient();
  const toast = useToast();
  const recorder = useRef<Recorder | null>(null);
  const startedAt = useRef<number | null>(null);
  const [state, setState] = useState<DictationState>("idle");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (state !== "recording") return;
    const tick = () => {
      if (startedAt.current == null) return;
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [state]);

  useEffect(
    () => () => {
      recorder.current?.dispose();
    },
    [],
  );

  const reset = useCallback(() => {
    recorder.current = null;
    startedAt.current = null;
    setElapsed(0);
    setState("idle");
  }, []);

  const watchResult = useCallback(
    async (recordingId: number, jobId: number) => {
      for (let i = 0; i < 90; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const jobs = await api.getJobs(recordingId).catch(() => []);
        const job = jobs.find((entry) => entry.job_id === jobId);
        if (!job || job.status === "pending" || job.status === "running") continue;
        if (job.status === "done") {
          const items = await api.listRecordingActionItems(recordingId).catch(() => []);
          const tasks = items.filter((item) => item.kind === "task").length;
          const decisions = items.filter((item) => item.kind === "decision").length;
          const suffix = [
            tasks ? `${tasks} Aufgabe${tasks === 1 ? "" : "n"}` : "",
            decisions ? `${decisions} Entscheidung${decisions === 1 ? "" : "en"}` : "",
          ].filter(Boolean).join(" · ");
          toast(suffix ? `Diktat verarbeitet · ${suffix}` : "Diktat verarbeitet", "success");
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["topics"] }),
            queryClient.invalidateQueries({ queryKey: ["recordings"] }),
            queryClient.invalidateQueries({ queryKey: ["action-items"] }),
            queryClient.invalidateQueries({ queryKey: ["latest-job", recordingId] }),
          ]);
        } else if (job.status === "failed") {
          toast(`Diktat-Verarbeitung fehlgeschlagen: ${job.error ?? "Unbekannter Fehler"}`, "error");
        }
        return;
      }
    },
    [queryClient, toast],
  );

  const start = useCallback(async () => {
    if (recorder.current || state !== "idle") return;
    const next = new Recorder();
    recorder.current = next;
    setState("starting");
    try {
      const settings = await api.getSettings();
      const usedFallback = await next.start(settings.recording_device_id);
      startedAt.current = Date.now();
      setElapsed(0);
      setState("recording");
      if (usedFallback) {
        toast("Das gewählte Mikrofon ist nicht verfügbar. Verwende das Systemstandardgerät.", "info");
      }
    } catch (e) {
      next.dispose();
      reset();
      toast(`Diktat nicht verfügbar: ${errorMessage(e)}`, "error");
    }
  }, [reset, state, toast]);

  const stopAndSave = useCallback(async () => {
    const current = recorder.current;
    if (!current || state !== "recording") return;
    setState("saving");
    try {
      const mimeType = current.mimeType;
      const blob = await current.stop();
      const stamp = new Date().toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const file = new File([blob], `diktat.${recordingExtension(mimeType)}`, { type: mimeType });
      const res = await api.createDictation(file, `Diktat ${stamp}`);
      trackPendingJob(res.recording.id, res.job_id, "asr");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["topics"] }),
        queryClient.invalidateQueries({ queryKey: ["recordings"] }),
        queryClient.invalidateQueries({ queryKey: ["recordings", res.topic_id] }),
        queryClient.invalidateQueries({ queryKey: ["latest-job", res.recording.id] }),
      ]);
      toast("Diktat gespeichert · Transkription läuft", "success");
      onOpenRecording(res.recording.id);
      void watchResult(res.recording.id, res.job_id);
    } catch (e) {
      toast(`Diktat konnte nicht gespeichert werden: ${errorMessage(e)}`, "error");
    } finally {
      current.dispose();
      reset();
    }
  }, [onOpenRecording, queryClient, reset, state, toast, watchResult]);

  const discard = useCallback(() => {
    recorder.current?.dispose();
    reset();
    toast("Diktat verworfen", "info");
  }, [reset, toast]);

  const toggle = useCallback(async () => {
    if (state === "idle") {
      await start();
    } else if (state === "recording") {
      await stopAndSave();
    }
  }, [start, state, stopAndSave]);

  return {
    state,
    elapsed,
    elapsedLabel: fmtDuration(elapsed),
    start,
    stopAndSave,
    discard,
    toggle,
  };
}
