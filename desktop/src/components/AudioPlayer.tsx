import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { api } from "../lib/api";
import { AudioRangeEditor } from "./recording-detail/AudioRangeEditor";
import {
  formatAudioTime, minimumAudioRange, moveAudioEdge,
  type AudioRange, type AudioRangeEdge,
} from "./recording-detail/audioRange";

export interface PlayerHandle {
  seek: (seconds: number) => void;
  playPause: () => void;
  playRange: (start: number, end: number) => Promise<boolean>;
}

interface Selection extends AudioRange {
  disabled: boolean;
  onChange: (start: number, end: number) => void;
  onEditingChange: (editing: boolean) => void;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export const AudioPlayer = forwardRef<PlayerHandle, {
  recordingId: number;
  audioPath: string;
  durationSec: number;
  initialSeekSec?: number | null;
  onTime: (time: number) => void;
  onPlaying?: (playing: boolean) => void;
  selection?: Selection;
}>(function AudioPlayer({
  recordingId, audioPath, durationSec, initialSeekSec, onTime, onPlaying, selection,
}, ref) {
  const container = useRef<HTMLDivElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const regions = useRef<{ selected: Region; before: Region; after: Region } | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationSec);
  const [error, setError] = useState<string | null>(null);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AudioRange>({ start: 0, end: durationSec });
  const [zoom, setZoom] = useState(1);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: durationSec });
  const draftRef = useRef(draft);
  const lastEmit = useRef(0);
  const callbacks = useRef({ onTime, onPlaying, selection });
  callbacks.current = { onTime, onPlaying, selection };
  const limit = durationSec || duration;
  const trimmed = !!selection && (selection.start > 0 || selection.end < limit);

  function updateDraft(range: AudioRange) {
    draftRef.current = range;
    setDraft(range);
  }

  async function playRange(start: number, end: number) {
    const wave = ws.current;
    if (!wave || !ready) return false;
    try {
      await wave.play(start, Math.min(end, wave.getDuration()));
      return true;
    } catch {
      setError("Audio konnte nicht abgespielt werden. Bitte erneut versuchen.");
      return false;
    }
  }

  function playPause() {
    const wave = ws.current;
    if (!wave) return;
    if (wave.isPlaying()) {
      wave.pause();
    } else if (editing) {
      const current = wave.getCurrentTime();
      void playRange(current >= draft.start && current < draft.end ? current : draft.start, draft.end);
    } else {
      void wave.play().catch(() => setError("Audio konnte nicht abgespielt werden."));
    }
  }

  useImperativeHandle(ref, () => ({
    seek: (seconds) => {
      const wave = ws.current;
      if (wave && ready) {
        wave.setTime(seconds);
        if (!wave.isPlaying()) void wave.play().catch(() => setError("Audio konnte nicht abgespielt werden."));
      }
    },
    playPause,
    playRange,
  }));

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setError(null);
    setWaveformError(null);
    void (async () => {
      try {
        const [url, waveform] = await Promise.all([
          api.audioUrl(recordingId, audioPath),
          api.getWaveform(recordingId).catch((reason: Error) => {
            if (!disposed) setWaveformError(reason.message);
            return { duration_sec: durationSec, peaks: [0, 0] };
          }),
        ]);
        if (disposed || !container.current) return;
        const media = document.createElement("audio");
        media.preload = "metadata";
        const wave = WaveSurfer.create({
          container: container.current, media, height: 72, normalize: true,
          waveColor: cssVar("--text-faint", "#66736d"),
          progressColor: cssVar("--accent", "#087f6d"),
          cursorColor: cssVar("--text", "#121716"),
          cursorWidth: 2, barWidth: 2, barGap: 2, barRadius: 1,
          url, peaks: [waveform.peaks],
          duration: Math.max(waveform.duration_sec || durationSec, 0.001),
          autoCenter: false,
        });
        ws.current = wave;
        wave.on("ready", () => {
          setReady(true);
          setDuration(wave.getDuration());
          setVisibleRange({ start: 0, end: wave.getDuration() });
          if (initialSeekSec != null && initialSeekSec > 0) wave.setTime(initialSeekSec);
        });
        wave.on("timeupdate", (position) => {
          setTime(position);
          if (performance.now() - lastEmit.current > 80) {
            lastEmit.current = performance.now();
            callbacks.current.onTime(position);
          }
        });
        wave.on("scroll", (start, end) => setVisibleRange({ start, end }));
        wave.on("play", () => { setPlaying(true); callbacks.current.onPlaying?.(true); });
        wave.on("pause", () => { setPlaying(false); callbacks.current.onPlaying?.(false); });
        wave.on("finish", () => { setPlaying(false); callbacks.current.onPlaying?.(false); });
        wave.on("error", () => setError("Die Audiodatei konnte nicht geöffnet werden. Bitte lade die Aufnahme erneut."));
      } catch (loadError) {
        if (!disposed) setError((loadError as Error).message);
      }
    })();
    return () => {
      disposed = true;
      ws.current?.destroy();
      ws.current = null;
    };
  }, [recordingId, audioPath, durationSec, initialSeekSec]);

  useEffect(() => {
    const wave = ws.current;
    if (!ready || !wave) return;
    wave.setOptions({ height: editing ? 112 : 72 });
    if (!editing) return;
    const plugin = wave.registerPlugin(RegionsPlugin.create());
    const selected = plugin.addRegion({
      id: "trim-selection", ...draftRef.current, drag: false, resize: true,
      minLength: minimumAudioRange(limit), color: cssVar("--selection-bg", "rgba(8,127,109,0.18)"),
    });
    const before = plugin.addRegion({ id: "trim-before", start: 0, end: draftRef.current.start,
      drag: false, resize: false, color: "transparent" });
    const after = plugin.addRegion({ id: "trim-after", start: draftRef.current.end, end: limit,
      drag: false, resize: false, color: "transparent" });
    regions.current = { selected, before, after };
    const unsubscribe = selected.on("update", () => {
      wave.pause();
      updateDraft({ start: selected.start, end: selected.end });
    });
    const cleanups: (() => void)[] = [];
    for (const edge of ["start", "end"] as const) {
      const handle = selected.element?.querySelector<HTMLElement>(
        `[part~="region-handle-${edge === "start" ? "left" : "right"}"]`,
      );
      if (!handle) continue;
      handle.tabIndex = 0;
      handle.setAttribute("role", "slider");
      handle.setAttribute("aria-label", edge === "start" ? "Anfang des Audiobereichs" : "Ende des Audiobereichs");
      handle.setAttribute("aria-orientation", "horizontal");
      handle.title = "Ziehen oder mit den Pfeiltasten verschieben. Umschalt: größere Schritte.";
      const keydown = (event: KeyboardEvent) => {
        if (callbacks.current.selection?.disabled) return;
        const range = draftRef.current;
        const step = event.shiftKey ? 1 : event.altKey ? 0.01 : 0.1;
        let position = range[edge];
        if (["ArrowRight", "ArrowUp"].includes(event.key)) position += step;
        else if (["ArrowLeft", "ArrowDown"].includes(event.key)) position -= step;
        else if (event.key === "Home") position = edge === "start" ? 0 : range.start + minimumAudioRange(limit);
        else if (event.key === "End") position = edge === "end" ? limit : range.end - minimumAudioRange(limit);
        else return;
        event.preventDefault();
        event.stopPropagation();
        wave.pause();
        updateDraft(moveAudioEdge(range, edge, position, limit));
      };
      const focus = () => handle.focus({ preventScroll: true });
      handle.addEventListener("keydown", keydown);
      handle.addEventListener("pointerdown", focus);
      cleanups.push(() => {
        handle.removeEventListener("keydown", keydown);
        handle.removeEventListener("pointerdown", focus);
      });
    }
    return () => {
      unsubscribe();
      cleanups.forEach((cleanup) => cleanup());
      regions.current = null;
      wave.unregisterPlugin(plugin);
    };
  }, [ready, editing, limit]);

  useEffect(() => {
    const current = regions.current;
    if (!current) return;
    if (Math.abs(current.selected.start - draft.start) > 0.00001
      || Math.abs(current.selected.end - draft.end) > 0.00001) {
      current.selected.setOptions({ start: draft.start, end: draft.end });
    }
    current.before.setOptions({ start: 0, end: draft.start });
    current.after.setOptions({ start: draft.end, end: limit });
    if (current.before.element) current.before.element.style.display = draft.start > 0 ? "" : "none";
    if (current.after.element) current.after.element.style.display = draft.end < limit ? "" : "none";
    if (current.selected.element) current.selected.element.style.pointerEvents = selection?.disabled ? "none" : "all";
    for (const edge of ["start", "end"] as const) {
      const handle = current.selected.element?.querySelector<HTMLElement>(
        `[part~="region-handle-${edge === "start" ? "left" : "right"}"]`,
      );
      handle?.setAttribute("aria-valuemin", String(edge === "start" ? 0 : draft.start + minimumAudioRange(limit)));
      handle?.setAttribute("aria-valuemax", String(edge === "end" ? limit : draft.end - minimumAudioRange(limit)));
      handle?.setAttribute("aria-valuenow", String(draft[edge]));
      handle?.setAttribute("aria-valuetext", formatAudioTime(draft[edge]));
      handle?.setAttribute("aria-disabled", String(!!selection?.disabled));
    }
  }, [draft, editing, ready, limit, selection?.disabled]);

  function changeZoom(next: number, anchor = ws.current?.getCurrentTime() ?? draft.start) {
    const wave = ws.current;
    if (!wave || !ready) return;
    const level = Math.max(1, Math.min(128, next));
    wave.zoom(level === 1 ? 0 : wave.getWidth() / wave.getDuration() * level);
    wave.setScrollTime(Math.max(0, anchor - wave.getDuration() / level / 2));
    setZoom(level);
    if (level === 1) setVisibleRange({ start: 0, end: wave.getDuration() });
  }

  function beginEditing() {
    if (!selection || selection.disabled) return;
    ws.current?.pause();
    updateDraft({ start: selection.start, end: selection.end });
    setEditing(true);
    selection.onEditingChange(true);
  }

  function finishEditing(apply: boolean) {
    ws.current?.pause();
    if (apply) selection?.onChange(draft.start, draft.end);
    changeZoom(1);
    setEditing(false);
    selection?.onEditingChange(false);
  }

  function moveEdge(edge: AudioRangeEdge, position: number) {
    ws.current?.pause();
    updateDraft(moveAudioEdge(draftRef.current, edge, position, limit));
  }

  function preview(start: number, end: number) {
    ws.current?.setScrollTime(Math.max(0, start - (visibleRange.end - visibleRange.start) / 8));
    void playRange(start, end);
  }

  const marks = Array.from({ length: 5 }, (_, index) =>
    visibleRange.start + (visibleRange.end - visibleRange.start) * index / 4);

  return (
    <section className={`player audio-workbench${editing ? " editing" : ""}`}
      aria-label={editing ? "Audio kürzen" : "Audiowiedergabe"}>
      {selection && (
        <div className="audio-workbench-header">
          <div>
            <strong>{editing ? "Audio kürzen" : "Audio"}</strong>
            <p>{editing ? "Ziehe die beiden Griffe. Der markierte Bereich bleibt erhalten."
              : trimmed ? `${formatAudioTime(selection.start)}–${formatAudioTime(selection.end)} für die Transkription ausgewählt`
              : "Vor der Transkription anhören und bei Bedarf kürzen."}</p>
          </div>
          {!editing && <button type="button" className="btn" onClick={beginEditing}
            disabled={!ready || selection.disabled}>{trimmed ? "Bereich ändern" : "Audio kürzen"}</button>}
        </div>
      )}
      <div className="audio-waveform-area">
        <div className="waveform-shell">
          {!ready && <span className={`waveform-status${error ? " error" : ""}`}>
            {error ?? "Wellenform wird vorbereitet…"}
          </span>}
          <div ref={container} className="waveform" />
        </div>
        <div className="audio-time-ruler" aria-hidden="true">
          {marks.map((mark, index) => <span key={index}>{formatAudioTime(mark)}</span>)}
        </div>
      </div>
      <div className="audio-transport">
        <button className="play-btn" type="button" onClick={playPause} disabled={!ready}
          aria-label={playing ? "Pause" : editing ? "Auswahl abspielen" : "Abspielen"}>
          {playing ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
          </svg> : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>}
        </button>
        <span className="player-time">{formatAudioTime(time)} / {formatAudioTime(duration)}</span>
        {editing && <div className="audio-zoom" role="group" aria-label="Wellenform vergrößern">
          <button type="button" className="btn ghost" aria-label="Wellenform verkleinern"
            disabled={zoom === 1 || selection?.disabled} onClick={() => changeZoom(zoom / 2)}>−</button>
          <span>{zoom}×</span>
          <button type="button" className="btn ghost" aria-label="Wellenform vergrößern"
            disabled={zoom === 128 || selection?.disabled} onClick={() => changeZoom(zoom * 2)}>+</button>
          <button type="button" className="btn ghost" disabled={zoom === 1 || selection?.disabled}
            onClick={() => changeZoom(1)}>Übersicht</button>
        </div>}
      </div>
      {error && ready && <p className="trim-field-error" role="alert">{error}</p>}
      {waveformError && <p className="trim-field-error" role="alert">Wellenform nicht verfügbar: {waveformError}</p>}
      {editing && selection && <>
        <AudioRangeEditor duration={limit} start={draft.start} end={draft.end} currentTime={time}
          disabled={selection.disabled} onMoveEdge={moveEdge} onPreview={preview}
          onFocusEdge={(edge) => ws.current?.setScrollTime(Math.max(0, draft[edge] - (visibleRange.end - visibleRange.start) / 2))}
          onReset={() => { ws.current?.pause(); updateDraft({ start: 0, end: limit }); changeZoom(1); }}
          onCancel={() => finishEditing(false)} onApply={() => finishEditing(true)} />
        <p className="trim-original-note">Deine Originalaufnahme bleibt unverändert.</p>
      </>}
    </section>
  );
});
