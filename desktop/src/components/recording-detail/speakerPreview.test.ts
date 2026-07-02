import { describe, expect, it } from "vitest";
import { findSpeakerPreview } from "./speakerPreview";

describe("findSpeakerPreview", () => {
  it("returns a centered six-second excerpt from the longest solo segment", () => {
    expect(findSpeakerPreview([{ speaker: "A", start: 10, end: 20 }], "A")).toEqual({
      start: 12,
      end: 18,
    });
  });

  it("removes interruptions by other speakers before selecting the excerpt", () => {
    const preview = findSpeakerPreview(
      [
        { speaker: "A", start: 0, end: 12 },
        { speaker: "B", start: 4, end: 9 },
      ],
      "A",
    );

    expect(preview?.start).toBeCloseTo(0.12);
    expect(preview?.end).toBeCloseTo(3.88);
  });

  it("does not treat overlapping segments from the same speaker as interruptions", () => {
    expect(
      findSpeakerPreview(
        [
          { speaker: "A", start: 0, end: 5 },
          { speaker: "A", start: 4, end: 10 },
        ],
        "A",
      ),
    ).toEqual({ start: 2, end: 8 });
  });

  it("returns null when no uninterrupted solo range is long enough", () => {
    expect(
      findSpeakerPreview(
        [
          { speaker: "A", start: 0, end: 3 },
          { speaker: "B", start: 1, end: 3 },
        ],
        "A",
      ),
    ).toBeNull();
  });
});
