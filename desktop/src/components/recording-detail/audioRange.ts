export type AudioRange = { start: number; end: number };
export type AudioRangeEdge = "start" | "end";

export function formatAudioTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const whole = Math.floor(tenths / 10);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const fraction = tenths % 10;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
}

export function parseAudioTime(text: string): number | null {
  const value = text.trim().replace(",", ".");
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value)) return null;
  const parts = value.split(":").map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return null;
  const result = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(result) ? result : null;
}

export function minimumAudioRange(duration: number): number {
  return Math.min(0.1, Math.max(0, duration));
}

export function moveAudioEdge(
  range: AudioRange, edge: AudioRangeEdge, position: number, duration: number,
): AudioRange {
  if (!Number.isFinite(position)) return range;
  const minimum = minimumAudioRange(duration);
  return edge === "start"
    ? { start: Math.max(0, Math.min(position, range.end - minimum)), end: range.end }
    : { start: range.start, end: Math.min(duration, Math.max(position, range.start + minimum)) };
}
