interface SpeakerSegment {
  speaker: string;
  start: number;
  end: number;
}

export interface SpeakerPreviewRange {
  start: number;
  end: number;
}

const MIN_PREVIEW_SECONDS = 1.5;
const MAX_PREVIEW_SECONDS = 6;
const EDGE_PADDING_SECONDS = 0.12;

function mergeRanges(ranges: SpeakerPreviewRange[]): SpeakerPreviewRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: SpeakerPreviewRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function subtractRanges(
  range: SpeakerPreviewRange,
  blockers: SpeakerPreviewRange[],
): SpeakerPreviewRange[] {
  let remaining = [range];

  for (const blocker of blockers) {
    remaining = remaining.flatMap((part) => {
      if (blocker.end <= part.start || blocker.start >= part.end) return [part];
      const pieces: SpeakerPreviewRange[] = [];
      if (blocker.start > part.start) pieces.push({ start: part.start, end: blocker.start });
      if (blocker.end < part.end) pieces.push({ start: blocker.end, end: part.end });
      return pieces;
    });
  }

  return remaining;
}

export function findSpeakerPreview(
  segments: SpeakerSegment[],
  speaker: string,
): SpeakerPreviewRange | null {
  const targetRanges = mergeRanges(
    segments
      .filter((segment) => segment.speaker === speaker)
      .map(({ start, end }) => ({ start, end })),
  );
  const blockers = mergeRanges(
    segments
      .filter((segment) => segment.speaker !== speaker)
      .map(({ start, end }) => ({ start, end })),
  );
  const exclusiveRanges = targetRanges
    .flatMap((range) => subtractRanges(range, blockers))
    .map((range) => ({
      start: range.start + EDGE_PADDING_SECONDS,
      end: range.end - EDGE_PADDING_SECONDS,
    }))
    .filter((range) => range.end - range.start >= MIN_PREVIEW_SECONDS)
    .sort((a, b) => b.end - b.start - (a.end - a.start));

  const best = exclusiveRanges[0];
  if (!best) return null;

  const duration = Math.min(MAX_PREVIEW_SECONDS, best.end - best.start);
  const center = (best.start + best.end) / 2;
  return {
    start: center - duration / 2,
    end: center + duration / 2,
  };
}
