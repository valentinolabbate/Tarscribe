export const PRESETS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export const KEY_PROVIDERS = new Set(["openai", "openrouter", "custom"]);

export function NumField({
  label,
  enabled,
  onToggle,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
}: {
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max?: number;
  step: number;
  placeholder?: string;
}) {
  return (
    <div className="tuning-row">
      <label>
        <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} /> {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={!enabled}
        placeholder={placeholder}
        style={{ width: 80, opacity: enabled ? 1 : 0.4 }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
