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
    label: "Kompakt",
    detail: "Für kleine M-Macs und lange Aufnahmen mit möglichst wenig Speicherdruck.",
    asr: "kurze Chunks",
    diarization: "Speaker-Matching pausiert",
  },
  {
    id: "balanced",
    label: "Ausgewogen",
    detail: "Der ruhige Standard für moderne Laptops, meist passend ab 16 GB RAM.",
    asr: "Standard-Chunks",
    diarization: "Speaker-Matching aktiv",
  },
  {
    id: "quality",
    label: "Hohe Qualität",
    detail: "Für aktuelle Laptops empfohlen ab 24 GB RAM; 16 GB gehen oft bei kürzeren Workflows.",
    asr: "größere Defaults",
    diarization: "volle Sprechererkennung",
  },
];

export function performanceProfileLabel(id: PerformanceProfile | null | undefined): string {
  return PERFORMANCE_PROFILES.find((profile) => profile.id === id)?.label ?? "Ausgewogen";
}
