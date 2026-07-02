import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import WaveSurfer from "wavesurfer.js";
import { api } from "../lib/api";

export interface PlayerHandle {
  seek: (seconds: number) => void;
  playPause: () => void;
  playRange: (start: number, end: number) => Promise<boolean>;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const AudioPlayer = forwardRef<
  PlayerHandle,
  {
    recordingId: number;
    audioPath: string;
    durationSec: number;
    onTime: (t: number) => void;
    onPlaying?: (p: boolean) => void;
  }
>(function AudioPlayer({ recordingId, audioPath, durationSec, onTime, onPlaying }, ref) {
    const container = useRef<HTMLDivElement>(null);
    const ws = useRef<WaveSurfer | null>(null);
    const [ready, setReady] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const lastEmit = useRef(0);

    useImperativeHandle(ref, () => ({
      seek: (seconds: number) => {
        const w = ws.current;
        if (w && duration > 0) {
          w.setTime(seconds);
          if (!w.isPlaying()) w.play();
        }
      },
      playPause: () => ws.current?.playPause(),
      playRange: async (start: number, end: number) => {
        const w = ws.current;
        if (!w || duration <= 0) return false;
        try {
          await w.play(start, Math.min(end, duration));
          return true;
        } catch {
          return false;
        }
      },
    }));

    useEffect(() => {
      let disposed = false;

      (async () => {
        try {
          const [url, waveform] = await Promise.all([
            api.audioUrl(recordingId, audioPath),
            api.getWaveform(recordingId).catch(() => ({
              duration_sec: durationSec,
              peaks: [0, 0],
            })),
          ]);
          if (disposed || !container.current) return;
          const media = document.createElement("audio");
          media.preload = "metadata";
          const w = WaveSurfer.create({
            container: container.current,
            media,
            height: 56,
            waveColor: cssVar("--border-strong", "#333a48"),
            progressColor: cssVar("--accent", "#6366f1"),
            cursorColor: cssVar("--text", "#e6e8ee"),
            barWidth: 2,
            barGap: 1,
            barRadius: 2,
            url,
            peaks: [waveform.peaks],
            duration: Math.max(waveform.duration_sec || durationSec, 0.001),
          });
          ws.current = w;
          w.on("ready", () => {
            setReady(true);
            setDuration(w.getDuration());
          });
          w.on("timeupdate", (t: number) => {
            setTime(t);
            const now = performance.now();
            if (now - lastEmit.current > 80) {
              lastEmit.current = now;
              onTime(t);
            }
          });
          w.on("play", () => {
            setPlaying(true);
            onPlaying?.(true);
          });
          w.on("pause", () => {
            setPlaying(false);
            onPlaying?.(false);
          });
          w.on("finish", () => {
            setPlaying(false);
            onPlaying?.(false);
          });
          w.on("error", () => setError("Audio konnte nicht geladen werden"));
        } catch (loadError) {
          if (!disposed) setError((loadError as Error).message);
        }
      })();

      return () => {
        disposed = true;
        ws.current?.destroy();
        ws.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recordingId]);

    return (
      <div className="player">
        <button
          className="play-btn"
          onClick={() => ws.current?.playPause()}
          disabled={!ready}
          aria-label={playing ? "Pause" : "Abspielen"}
        >
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <div className="waveform-shell">
          {!ready && (
            <span className={`waveform-status${error ? " error" : ""}`}>
              {error ?? "Wellenform wird vorbereitet…"}
            </span>
          )}
          <div ref={container} className="waveform" />
        </div>
        <span className="player-time">
          {fmt(time)} / {fmt(duration)}
        </span>
      </div>
    );
  },
);
