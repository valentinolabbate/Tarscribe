export const PRESETS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export const KEY_PROVIDERS = new Set(["openai", "openrouter", "custom"]);

export const PROVIDER_OPTIONS: Array<[string, string]> = [
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  ["custom", "OpenAI-kompatibel"],
];

export interface ModelSelectOption {
  value: string;
  label: string;
  available: boolean;
}

export function buildModelSelectOptions(
  models: string[],
  currentModel?: string | null,
): ModelSelectOption[] {
  const seen = new Set<string>();
  const options: ModelSelectOption[] = [];
  const current = currentModel?.trim();

  if (current) {
    seen.add(current);
    options.push({
      value: current,
      label: current,
      available: models.some((model) => model.trim() === current),
    });
  }

  for (const model of models) {
    const value = model.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: value, available: true });
  }

  return options.map((option) =>
    option.available ? option : { ...option, label: `${option.label} (gespeichert)` },
  );
}

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
