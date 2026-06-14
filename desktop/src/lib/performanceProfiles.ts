import type { PerformanceProfile } from "./types";

export const PERFORMANCE_PROFILES: Array<{
  id: PerformanceProfile;
  label: string;
  detail: string;
  asr: string;
  diarization: string;
}> = [
  {
    id: "m1_8gb",
    label: "M1 / 8 GB",
    detail: "Nutzt Apple-GPU mit kleinerem Speicher-Footprint.",
    asr: "MLX/MPS, kurze Chunks",
    diarization: "pyannote auf MPS, ohne Auto-Matching",
  },
  {
    id: "balanced",
    label: "M-Serie Standard",
    detail: "Empfohlen für M-Macs mit 16 GB oder mehr.",
    asr: "MLX/MPS Standard",
    diarization: "pyannote + Auto-Matching",
  },
  {
    id: "quality",
    label: "Max. Qualität",
    detail: "Für Pro/Max/Ultra oder viel Speicher.",
    asr: "größere Modelle wo sinnvoll",
    diarization: "volle Sprechererkennung",
  },
];

export function performanceProfileLabel(id: PerformanceProfile | null | undefined): string {
  return PERFORMANCE_PROFILES.find((profile) => profile.id === id)?.label ?? "M-Serie Standard";
}
