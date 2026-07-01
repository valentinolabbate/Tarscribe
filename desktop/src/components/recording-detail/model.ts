import type { WordSeg } from "../../lib/types";

const SPEAKER_COLORS = [
  "#0f766e",
  "#2563eb",
  "#b45309",
  "#be185d",
  "#0891b2",
  "#7c3aed",
  "#dc2626",
  "#4d7c0f",
];

export type DetailTab = "transcript" | "summary" | "ask" | "speakers";
export type FlowStepState = "done" | "active" | "next" | "waiting" | "optional" | "error";

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

export interface FlowStep {
  key: string;
  label: string;
  eyebrow: string;
  detail: string;
  state: FlowStepState;
  progress?: number | null;
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

export const colorFor = (label: string, all: string[]) =>
  SPEAKER_COLORS[Math.max(0, all.indexOf(label)) % SPEAKER_COLORS.length];

export const timestamp = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function groupWordsIntoSentences(words: WordSeg[]): Sentence[] {
  const sentences: Sentence[] = [];
  let current: WordSeg[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = current.map((word) => word.text).join("").trim();
    if (text) {
      sentences.push({ start: current[0].start, end: current[current.length - 1].end, text });
    }
    current = [];
  };
  const endsSentence = /[.!?…]["'”’)\]]*$/;
  const pauseSec = 0.8;
  const maxWords = 45;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    current.push(word);
    const trimmed = word.text.trim();
    const next = words[index + 1];
    const gap = next ? next.start - word.end : Infinity;
    if (
      (trimmed && endsSentence.test(trimmed)) ||
      (current.length >= 4 && gap >= pauseSec) ||
      current.length >= maxWords
    ) {
      flush();
    }
  }
  flush();
  return sentences;
}
