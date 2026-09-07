import type { LocalModelStatus } from "../../lib/types";

export type AsrEngine = "" | "parakeet-mlx" | "mlx-whisper" | "faster-whisper"
  | "qwen3-mlx" | "nemotron-mlx" | "moss-mlx" | "vibevoice-mlx" | "vibevoice-bitnet";

export const ASR_ENGINE_LABELS: Record<Exclude<AsrEngine, "">, string> = {
  "parakeet-mlx": "Parakeet MLX", "mlx-whisper": "MLX Whisper", "faster-whisper": "faster-whisper",
  "qwen3-mlx": "Qwen3-ASR", "nemotron-mlx": "Nemotron 3.5", "moss-mlx": "MOSS",
  "vibevoice-mlx": "VibeVoice Streaming", "vibevoice-bitnet": "VibeVoice BitNet",
};

export const ASR_PURPOSES = [
  { id: "everyday", label: "Bewährt" }, { id: "quality", label: "Qualität" },
  { id: "live", label: "Live" }, { id: "speakers", label: "Sprecher" },
  { id: "cpu", label: "CPU" }, { id: "all", label: "Alle" },
] as const;
export type AsrPurpose = (typeof ASR_PURPOSES)[number]["id"];

export function asrPurpose(engine: AsrEngine): AsrPurpose {
  if (engine === "qwen3-mlx") return "quality";
  if (engine === "nemotron-mlx" || engine === "vibevoice-mlx") return "live";
  if (engine === "moss-mlx") return "speakers";
  if (engine === "vibevoice-bitnet" || engine === "faster-whisper") return "cpu";
  return "everyday";
}

export function experimentalAsr(engine: AsrEngine): boolean {
  return !["", "parakeet-mlx", "mlx-whisper", "faster-whisper"].includes(engine);
}

export const ASR_MODEL_SUGGESTIONS: Array<{
  engine: Exclude<AsrEngine, "">;
  label: string;
  model: string;
  note: string;
}> = [
  {
    engine: "qwen3-mlx", label: "Qwen3-ASR 1.7B", model: "mlx-community/Qwen3-ASR-1.7B-8bit",
    note: "Apple-GPU · Qualitätsalternative mit zusätzlichem Wort-Aligner",
  },
  {
    engine: "nemotron-mlx", label: "Nemotron 3.5 ASR",
    model: "mlx-community/nemotron-3.5-asr-streaming-0.6b",
    note: "Apple-GPU · Streaming-Architektur mit nativen Zeitmarken",
  },
  {
    engine: "moss-mlx", label: "MOSS Transcribe Diarize",
    model: "OpenMOSS-Team/MOSS-Transcribe-Diarize",
    note: "Apple-GPU · Sprechertrennung und Transkription gemeinsam",
  },
  {
    engine: "vibevoice-mlx", label: "VibeVoice ASR Streaming",
    model: "microsoft/VibeVoice-ASR-Streaming-1.5B",
    note: "Apple-GPU · Inkrementelle Erkennung mit Fachbegriffen",
  },
  {
    engine: "vibevoice-bitnet", label: "VibeVoice ASR BitNet",
    model: "microsoft/VibeVoice-ASR-BitNet",
    note: "CPU-Erkennung · Separate Laufzeit, Wortausrichtung über Apple-GPU",
  },
  {
    engine: "parakeet-mlx",
    label: "Parakeet MLX",
    model: "mlx-community/parakeet-tdt-0.6b-v3",
    note: "empfohlen auf Apple Silicon",
  },
  {
    engine: "mlx-whisper",
    label: "MLX Whisper Large v3 Turbo",
    model: "mlx-community/whisper-large-v3-turbo",
    note: "Apple-GPU, schneller als volle Large v3",
  },
  {
    engine: "mlx-whisper",
    label: "MLX Whisper Large v3",
    model: "mlx-community/whisper-large-v3-mlx",
    note: "Apple-GPU, volle Large-v3-Qualität",
  },
  {
    engine: "mlx-whisper",
    label: "MLX Distil Large v3",
    model: "mlx-community/distil-whisper-large-v3",
    note: "Apple-GPU, auf Englisch spezialisiert",
  },
  { engine: "faster-whisper", label: "Whisper Small", model: "small", note: "CPU auf Mac, CUDA auf NVIDIA" },
  { engine: "faster-whisper", label: "Whisper Medium", model: "medium", note: "CPU auf Mac, CUDA auf NVIDIA" },
  {
    engine: "faster-whisper",
    label: "Whisper Large v3",
    model: "large-v3",
    note: "CPU auf Mac, CUDA auf NVIDIA",
  },
  {
    engine: "faster-whisper",
    label: "Distil Large v3",
    model: "distil-large-v3",
    note: "CPU auf Mac, CUDA auf NVIDIA",
  },
];

const FASTER_WHISPER_ALIASES = new Set([
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large",
  "large-v1",
  "large-v2",
  "large-v3",
  "distil-small.en",
  "distil-medium.en",
  "distil-large-v2",
  "distil-large-v3",
]);

export const DIARIZATION_MODEL_SUGGESTIONS = [
  { label: "Community 1", model: "pyannote/speaker-diarization-community-1", note: "aktueller Standard" },
  { label: "Pyannote 3.1", model: "pyannote/speaker-diarization-3.1", note: "Alternative mit HF-Lizenz" },
  { label: "Pyannote 3.0", model: "pyannote/speaker-diarization-3.0", note: "ältere Alternative" },
];

export function asrModelPlaceholder(engine: AsrEngine): string {
  if (experimentalAsr(engine)) return ASR_MODEL_SUGGESTIONS.find((s) => s.engine === engine)?.model ?? "";
  if (engine === "faster-whisper") return "medium, large-v3 oder eigener Modellname";
  if (engine === "mlx-whisper") return "mlx-community/whisper-large-v3-mlx";
  return "mlx-community/parakeet-tdt-0.6b-v3";
}

export function asrEngineValue(value: string | null | undefined): AsrEngine {
  if (value && Object.prototype.hasOwnProperty.call(ASR_ENGINE_LABELS, value)) {
    return value as AsrEngine;
  }
  return "";
}

export function normalizeAsrModelForEngine(engine: AsrEngine, model: string | null | undefined): string {
  const value = (model ?? "").trim();
  if (!value) return "";
  const knownSuggestion = ASR_MODEL_SUGGESTIONS.find((suggestion) => suggestion.model === value);
  if (knownSuggestion && knownSuggestion.engine !== engine) return "";
  if (!engine && knownSuggestion) return "";
  if (engine !== "faster-whisper" && FASTER_WHISPER_ALIASES.has(value)) return "";
  if (engine === "faster-whisper" && value.startsWith("mlx-community/")) return "";
  if (engine === "parakeet-mlx" && value.startsWith("mlx-community/whisper")) return "";
  if (engine === "mlx-whisper" && value.startsWith("mlx-community/parakeet")) return "";
  return value;
}

export function findModelStatus(
  items: LocalModelStatus[] | undefined,
  kind: LocalModelStatus["kind"],
  model: string,
  engine?: string,
): LocalModelStatus | null {
  return (
    items?.find(
      (item) =>
        item.kind === kind &&
        item.model === model &&
        (engine === undefined || item.engine === engine),
    ) ?? null
  );
}

export function activeModelStatus(
  items: LocalModelStatus[] | undefined,
  kind: LocalModelStatus["kind"],
): LocalModelStatus | null {
  return items?.find((item) => item.kind === kind && item.active) ?? null;
}

function formatGb(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)).replace(".", ",");
}

export function runtimeMemoryLabel(item: LocalModelStatus | null): string | null {
  if (item?.runtime_memory_min_gb === undefined || item.runtime_memory_max_gb === undefined) {
    return null;
  }
  const min = item.runtime_memory_min_gb;
  const max = item.runtime_memory_max_gb;
  if (Math.abs(max - min) < 0.1) return `ca. ${formatGb(max)} GB RAM`;
  return `ca. ${formatGb(min)}-${formatGb(max)} GB RAM`;
}

function modelRuntimeTitle(item: LocalModelStatus): string {
  if (item.kind === "asr") return "Trans.";
  if (item.kind === "diarization") return "Diar.";
  return "Speaker";
}

export function activeRuntimeSummary(
  items: LocalModelStatus[],
  memoryGb?: number | null,
): { total: string; parts: string; budgetLabel?: string; budgetPercent?: number } | null {
  const activeItems = items.filter(
    (item) =>
      item.active &&
      item.runtime_memory_min_gb !== undefined &&
      item.runtime_memory_max_gb !== undefined,
  );
  if (!activeItems.length) return null;
  const min = activeItems.reduce((sum, item) => sum + (item.runtime_memory_min_gb ?? 0), 0);
  const max = activeItems.reduce((sum, item) => sum + (item.runtime_memory_max_gb ?? 0), 0);
  const total =
    Math.abs(max - min) < 0.1
      ? `ca. ${formatGb(max)} GB RAM`
      : `ca. ${formatGb(min)}-${formatGb(max)} GB RAM`;
  const parts = activeItems
    .map((item) => `${modelRuntimeTitle(item)} ${runtimeMemoryLabel(item)?.replace("ca. ", "")}`)
    .join(" · ");
  const budgetPercent = memoryGb ? Math.min(100, Math.round((max / memoryGb) * 100)) : undefined;
  const budgetLabel = memoryGb ? `gegen ${formatGb(memoryGb)} GB RAM: ${budgetPercent}%` : undefined;
  return { total, parts, budgetLabel, budgetPercent };
}

export function ModelStatusBadge({ item, loading }: { item: LocalModelStatus | null; loading?: boolean }) {
  if (loading && !item) return <span className="model-status-badge neutral">Prüfe…</span>;
  if (!item) return <span className="model-status-badge neutral">Unbekannt</span>;
  return (
    <span className={item.downloaded ? "model-status-badge ready" : "model-status-badge missing"}>
      {item.downloaded ? "Geladen" : "Fehlt"}
    </span>
  );
}

export function ModelStatusCard({
  title,
  item,
  loading,
}: {
  title: string;
  item: LocalModelStatus | null;
  loading?: boolean;
}) {
  return (
    <div className="model-status-card">
      <div className="model-status-card-head">
        <span>{title}</span>
        <ModelStatusBadge item={item} loading={loading} />
      </div>
      <code>{item?.model ?? "Wird ermittelt…"}</code>
      {runtimeMemoryLabel(item) && (
        <small className="model-runtime-line">Laufzeit: {runtimeMemoryLabel(item)}</small>
      )}
      {item && !item.active && item.kind === "embedding" && (
        <small className="model-runtime-line">Nicht im aktuellen Profil aktiv.</small>
      )}
      {item?.note && <small>{item.note}</small>}
    </div>
  );
}
