export function fmtDuration(sec: number): string {
  if (!sec || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Hochgeladen",
  queued: "In Warteschlange",
  transcribing: "Transkribiert…",
  diarizing: "Diarisiert…",
  ready: "Fertig",
  failed: "Fehler",
};
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

const JOB_PHASE_LABEL: Record<string, string> = {
  asr: "Transkribiere",
  diarization: "Erkenne Sprecher",
  summarize: "Erstelle Zusammenfassung",
  embedding: "Indexiere für Suche",
  action_items: "Extrahiere Aufgaben",
  chapters: "Erkenne Kapitel",
  digest: "Erstelle Wochen-Digest",
};
export const jobPhaseLabel = (phase?: string) => JOB_PHASE_LABEL[phase ?? ""] ?? "Verarbeite";
