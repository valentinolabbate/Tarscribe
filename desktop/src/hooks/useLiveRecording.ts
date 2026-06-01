/**
 * Manages live recording session state and chunk upload queue.
 *
 * Design goals:
 * - Upload failures degrade the live preview only — never stop the archive recording.
 * - Chunks are uploaded strictly in order (idempotency on retry is handled server-side).
 * - A small bounded buffer caps memory; once full, new chunks are dropped with a warning.
 */

import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";
import type { LiveEvent, LiveSession, LiveTranscriptSnapshot, LiveSpeakerSnapshot } from "../lib/types";

const MAX_BUFFER = 30; // max queued chunks before we drop new ones
const MAX_RETRIES = 3;

interface QueueEntry {
  seq: number;
  data: ArrayBuffer;
  retries: number;
}

export interface LiveRecordingHandle {
  sessionId: string | null;
  receivedDurationSec: number;
  queueLength: number;
  hasUploadError: boolean;
  degraded: boolean;
  degradedReason: string | null;
  transcriptSnapshot: LiveTranscriptSnapshot | null;
  speakerSnapshot: LiveSpeakerSnapshot | null;

  /** Call after the archive recording has been uploaded and we have a Recording ID. */
  finish: (recordingId: number | null) => Promise<void>;
  /** Notify backend the session is paused (optional — backend is resilient to missing pause signals). */
  notifyPause: () => Promise<void>;
  /** Notify backend the session resumed. */
  notifyResume: () => Promise<void>;
  /** Cancel (e.g. on user abort before stop). */
  cancel: () => Promise<void>;
  /** Handle a live WebSocket event for this session. */
  onLiveEvent: (e: LiveEvent) => void;
}

export function useLiveRecording(): {
  startSession: (topicId: number, title: string) => Promise<string | null>;
  enqueueChunk: (chunk: ArrayBuffer) => void;
  handle: LiveRecordingHandle | null;
} {
  const sessionRef = useRef<LiveSession | null>(null);
  const queueRef = useRef<QueueEntry[]>([]);
  const uploadingRef = useRef(false);
  const highWaterRef = useRef(-1);
  const [queueLength, setQueueLength] = useState(0);
  const [receivedDurationSec, setReceivedDurationSec] = useState(0);
  const [hasUploadError, setHasUploadError] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [transcriptSnapshot, setTranscriptSnapshot] = useState<LiveTranscriptSnapshot | null>(null);
  const [speakerSnapshot, setSpeakerSnapshot] = useState<LiveSpeakerSnapshot | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const drainQueue = useCallback(async () => {
    if (uploadingRef.current || queueRef.current.length === 0 || !sessionRef.current) return;
    uploadingRef.current = true;

    while (queueRef.current.length > 0 && sessionRef.current) {
      const entry = queueRef.current[0];
      try {
        const result = await api.uploadPcmChunk(
          sessionRef.current.id,
          entry.data,
          entry.seq,
          sessionRef.current.sample_rate,
          sessionRef.current.channels,
        );
        highWaterRef.current = result.last_sequence_number;
        setReceivedDurationSec(result.received_duration_sec);
        queueRef.current.shift();
        setQueueLength(queueRef.current.length);
        setHasUploadError(false);
      } catch {
        entry.retries++;
        if (entry.retries >= MAX_RETRIES) {
          console.warn(`[live] chunk ${entry.seq} failed after ${MAX_RETRIES} retries — dropping`);
          queueRef.current.shift();
          setQueueLength(queueRef.current.length);
          setHasUploadError(true);
        } else {
          // Back off briefly before retry
          await new Promise((r) => setTimeout(r, 500 * entry.retries));
        }
      }
    }

    uploadingRef.current = false;
  }, []);

  const enqueueChunk = useCallback(
    (chunk: ArrayBuffer) => {
      if (!sessionRef.current) return;
      if (queueRef.current.length >= MAX_BUFFER) {
        console.warn("[live] upload buffer full — dropping chunk");
        setHasUploadError(true);
        return;
      }
      const seq = highWaterRef.current + 1 + queueRef.current.length;
      queueRef.current.push({ seq, data: chunk, retries: 0 });
      setQueueLength(queueRef.current.length);
      drainQueue();
    },
    [drainQueue],
  );

  const startSession = useCallback(
    async (topicId: number, title: string): Promise<string | null> => {
      try {
        const session = await api.createLiveSession(topicId, title);
        sessionRef.current = session;
        highWaterRef.current = -1;
        queueRef.current = [];
        uploadingRef.current = false;
        setSessionId(session.id);
        setReceivedDurationSec(0);
        setHasUploadError(false);
        setDegraded(false);
        setDegradedReason(null);
        setQueueLength(0);
        setTranscriptSnapshot(null);
        setSpeakerSnapshot(null);
        return session.id;
      } catch (e) {
        console.error("[live] session creation failed:", e);
        return null;
      }
    },
    [],
  );

  const finish = useCallback(async (recordingId: number | null) => {
    if (!sessionRef.current) return;
    try {
      await api.finishLiveSession(sessionRef.current.id, recordingId);
    } catch (e) {
      console.warn("[live] finish failed:", e);
    } finally {
      sessionRef.current = null;
      setSessionId(null);
    }
  }, []);

  const notifyPause = useCallback(async () => {
    if (!sessionRef.current) return;
    try { await api.pauseLiveSession(sessionRef.current.id); } catch { /* best-effort */ }
  }, []);

  const notifyResume = useCallback(async () => {
    if (!sessionRef.current) return;
    try { await api.resumeLiveSession(sessionRef.current.id); } catch { /* best-effort */ }
  }, []);

  const cancel = useCallback(async () => {
    if (!sessionRef.current) return;
    const id = sessionRef.current.id;
    sessionRef.current = null;
    queueRef.current = [];
    setSessionId(null);
    try { await api.cancelLiveSession(id); } catch { /* best-effort */ }
  }, []);

  const onLiveEvent = useCallback((e: LiveEvent) => {
    if (!sessionRef.current || e.session_id !== sessionRef.current.id) return;
    if (e.type === "live_session" && e.received_duration_sec !== undefined) {
      setReceivedDurationSec(e.received_duration_sec);
    } else if (e.type === "live_transcript") {
      setTranscriptSnapshot(e.snapshot);
    } else if (e.type === "live_speakers") {
      setSpeakerSnapshot(e.snapshot);
    } else if (e.type === "live_degraded") {
      setDegraded(true);
      setDegradedReason(e.reason ?? null);
    }
  }, []);

  const handle: LiveRecordingHandle | null = sessionId
    ? {
        sessionId,
        receivedDurationSec,
        queueLength,
        hasUploadError,
        degraded,
        degradedReason,
        transcriptSnapshot,
        speakerSnapshot,
        finish,
        notifyPause,
        notifyResume,
        cancel,
        onLiveEvent,
      }
    : null;

  return { startSession, enqueueChunk, handle };
}
