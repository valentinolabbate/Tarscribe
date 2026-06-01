import { useState } from "react";
import { useDiarize } from "../hooks/queries";
import type { DiarizeParams } from "../lib/api";

type Mode = "auto" | "exact" | "range";

export function TuningPanel({
  recordingId,
  initial,
  disabled,
}: {
  recordingId: number;
  initial: Record<string, number | null>;
  disabled: boolean;
}) {
  const diarize = useDiarize();
  const [mode, setMode] = useState<Mode>(
    initial.num_speakers ? "exact" : initial.min_speakers || initial.max_speakers ? "range" : "auto",
  );
  const [exact, setExact] = useState(initial.num_speakers ?? 2);
  const [min, setMin] = useState(initial.min_speakers ?? 1);
  const [max, setMax] = useState(initial.max_speakers ?? 4);
  const [useThreshold, setUseThreshold] = useState(initial.clustering_threshold != null);
  const [threshold, setThreshold] = useState(initial.clustering_threshold ?? 0.7);
  const [useSilence, setUseSilence] = useState(initial.min_duration_off != null);
  const [silence, setSilence] = useState(initial.min_duration_off ?? 0.5);

  function apply() {
    const params: DiarizeParams = {};
    if (mode === "exact") params.num_speakers = exact;
    if (mode === "range") {
      params.min_speakers = min;
      params.max_speakers = max;
    }
    if (useThreshold) params.clustering_threshold = threshold;
    if (useSilence) params.min_duration_off = silence;
    diarize.mutate({ id: recordingId, params });
  }

  return (
    <div className="tuning">
      <div className="tuning-row">
        <label>Sprecheranzahl</label>
        <div className="seg">
          {(["auto", "exact", "range"] as Mode[]).map((m) => (
            <button
              key={m}
              className={mode === m ? "seg-btn active" : "seg-btn"}
              onClick={() => setMode(m)}
            >
              {m === "auto" ? "Automatisch" : m === "exact" ? "Genau" : "Bereich"}
            </button>
          ))}
        </div>
      </div>

      {mode === "exact" && (
        <div className="tuning-row">
          <label>Anzahl</label>
          <input
            type="number"
            min={1}
            max={20}
            value={exact}
            onChange={(e) => setExact(+e.target.value)}
            style={{ width: 70 }}
          />
        </div>
      )}
      {mode === "range" && (
        <div className="tuning-row">
          <label>Min – Max</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="number" min={1} max={20} value={min} onChange={(e) => setMin(+e.target.value)} style={{ width: 64 }} />
            <input type="number" min={1} max={20} value={max} onChange={(e) => setMax(+e.target.value)} style={{ width: 64 }} />
          </div>
        </div>
      )}

      <div className="tuning-row">
        <label>
          <input type="checkbox" checked={useThreshold} onChange={(e) => setUseThreshold(e.target.checked)} />{" "}
          Clustering-Threshold
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: useThreshold ? 1 : 0.4 }}>
          <input
            type="range"
            min={0.1}
            max={0.95}
            step={0.05}
            value={threshold}
            disabled={!useThreshold}
            onChange={(e) => setThreshold(+e.target.value)}
          />
          <span className="mono" style={{ width: 34 }}>{threshold.toFixed(2)}</span>
        </div>
      </div>
      <div className="tuning-hint">
        Höher = weniger Sprecher (mehr zusammengefasst), niedriger = mehr Sprecher.
      </div>

      <div className="tuning-row">
        <label>
          <input type="checkbox" checked={useSilence} onChange={(e) => setUseSilence(e.target.checked)} />{" "}
          Min. Stille (s)
        </label>
        <input
          type="number"
          min={0}
          max={5}
          step={0.1}
          value={silence}
          disabled={!useSilence}
          onChange={(e) => setSilence(+e.target.value)}
          style={{ width: 70, opacity: useSilence ? 1 : 0.4 }}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
        <button className="btn primary" onClick={apply} disabled={disabled || diarize.isPending}>
          Neu diarisieren
        </button>
      </div>
      <div className="tuning-hint" style={{ marginTop: 6 }}>
        Wendet die Parameter an, ohne neu zu transkribieren. Manuelle Korrekturen bleiben erhalten.
      </div>
    </div>
  );
}
