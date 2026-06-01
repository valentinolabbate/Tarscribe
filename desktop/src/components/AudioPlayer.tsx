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
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const AudioPlayer = forwardRef<
  PlayerHandle,
  { recordingId: number; onTime: (t: number) => void; onPlaying?: (p: boolean) => void }
>(function AudioPlayer({ recordingId, onTime, onPlaying }, ref) {
    const container = useRef<HTMLDivElement>(null);
    const ws = useRef<WaveSurfer | null>(null);
    const [ready, setReady] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
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
    }));

    useEffect(() => {
      let disposed = false;
      let objectUrl: string | null = null;

      (async () => {
        const url = await api.audioUrl(recordingId);
        if (disposed || !container.current) return;
        objectUrl = url;
        const w = WaveSurfer.create({
          container: container.current,
          height: 56,
          waveColor: cssVar("--border-strong", "#333a48"),
          progressColor: cssVar("--accent", "#6366f1"),
          cursorColor: cssVar("--text", "#e6e8ee"),
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          url,
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
      })();

      return () => {
        disposed = true;
        ws.current?.destroy();
        ws.current = null;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
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
        <div ref={container} className="waveform" />
        <span className="player-time">
          {fmt(time)} / {fmt(duration)}
        </span>
      </div>
    );
  },
);
