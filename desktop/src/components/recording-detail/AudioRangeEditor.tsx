import { useCallback, useEffect, useId, useState } from "react";
import { formatAudioTime, minimumAudioRange, parseAudioTime, type AudioRangeEdge } from "./audioRange";

function TimecodeField({ label, value, min, max, disabled, onChange, onFocus, onValidityChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
  onFocus: () => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const parsedDraft = draft === null ? value : parseAudioTime(draft);
  const valid = parsedDraft !== null && parsedDraft >= min && parsedDraft <= max;
  useEffect(() => onValidityChange(valid), [valid, onValidityChange]);
  function commit() {
    if (draft === null) return;
    const parsed = parseAudioTime(draft);
    if (parsed === null || parsed < min || parsed > max) {
      setError(true);
      return;
    }
    onChange(parsed);
    setDraft(null);
    setError(false);
  }
  return (
    <div className="trim-time-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" spellCheck={false} disabled={disabled}
        value={draft ?? formatAudioTime(value)} aria-invalid={error || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onFocus={onFocus} onChange={(event) => { setDraft(event.target.value); setError(false); }}
        onBlur={commit} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { event.preventDefault(); setDraft(null); setError(false); }
        }} />
      {error && <small className="trim-field-error" id={`${id}-error`}>
        Zeit zwischen {formatAudioTime(min)} und {formatAudioTime(max)} eingeben.
      </small>}
    </div>
  );
}

export function AudioRangeEditor({
  duration, start, end, currentTime, disabled, onMoveEdge, onPreview, onFocusEdge,
  onReset, onCancel, onApply,
}: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  disabled: boolean;
  onMoveEdge: (edge: AudioRangeEdge, value: number) => void;
  onPreview: (start: number, end: number) => void;
  onFocusEdge: (edge: AudioRangeEdge) => void;
  onReset: () => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const minimum = minimumAudioRange(duration);
  const [startValid, setStartValid] = useState(true);
  const [endValid, setEndValid] = useState(true);
  const reportStartValidity = useCallback((valid: boolean) => setStartValid(valid), []);
  const reportEndValidity = useCallback((valid: boolean) => setEndValid(valid), []);
  return (
    <div className="trim-editor-controls">
      <div className="trim-boundaries">
        <div className="trim-boundary">
          <TimecodeField label="Anfang" value={start} min={0} max={end - minimum}
            disabled={disabled} onChange={(value) => onMoveEdge("start", value)}
            onFocus={() => onFocusEdge("start")} onValidityChange={reportStartValidity} />
          <div className="trim-boundary-actions">
            <button className="btn ghost" type="button" disabled={disabled}
              onClick={() => onMoveEdge("start", currentTime)}>Hier beginnen</button>
            <button className="btn ghost" type="button" disabled={disabled}
              onClick={() => onPreview(start, Math.min(end, start + 4))}>Anfang anhören</button>
          </div>
        </div>
        <div className="trim-boundary">
          <TimecodeField label="Ende" value={end} min={start + minimum} max={duration}
            disabled={disabled} onChange={(value) => onMoveEdge("end", value)}
            onFocus={() => onFocusEdge("end")} onValidityChange={reportEndValidity} />
          <div className="trim-boundary-actions">
            <button className="btn ghost" type="button" disabled={disabled}
              onClick={() => onMoveEdge("end", currentTime)}>Hier enden</button>
            <button className="btn ghost" type="button" disabled={disabled}
              onClick={() => onPreview(Math.max(start, end - 4), end)}>Ende anhören</button>
          </div>
        </div>
      </div>
      <div className="trim-selection-summary" role="status">
        <strong>{formatAudioTime(end - start)} bleiben erhalten</strong>
        <span>{start === 0 && end === duration ? "Die gesamte Aufnahme ist ausgewählt."
          : `${formatAudioTime(start)} am Anfang und ${formatAudioTime(duration - end)} am Ende werden ausgelassen.`}</span>
      </div>
      <div className="trim-editor-footer">
        <button type="button" className="btn ghost" disabled={disabled || (start === 0 && end === duration)}
          onClick={onReset}>Zurücksetzen</button>
        <div>
          <button type="button" className="btn" onClick={onCancel}>Abbrechen</button>
          <button type="button" className="btn primary" disabled={disabled || !startValid || !endValid}
            onClick={onApply}>Bereich übernehmen</button>
        </div>
      </div>
    </div>
  );
}
