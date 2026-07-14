import { describe, expect, it } from "vitest";
import { needsEvidenceReview } from "./model";

describe("needsEvidenceReview", () => {
  it("selects unsupported tasks that still need a user decision", () => {
    expect(
      needsEvidenceReview({ kind: "task", attention_flags: ["missing_source", "needs_evidence_review"] }),
    ).toBe(true);
    expect(needsEvidenceReview({ kind: "task", attention_flags: ["missing_source"] })).toBe(false);
    expect(
      needsEvidenceReview({ kind: "decision", attention_flags: ["needs_evidence_review"] }),
    ).toBe(false);
  });
});
