import { describe, expect, it } from "vitest";
import { getSummaryRun, trackSummaryStart } from "./useJobs";

describe("summary run tracking", () => {
  it("keeps the active summary and job IDs outside the summary tab", () => {
    trackSummaryStart(41, 73, 109);
    expect(getSummaryRun(41)).toEqual({ summaryId: 73, jobId: 109 });
  });

  it("replaces a recording's previous summary run", () => {
    trackSummaryStart(42, 74, 110);
    trackSummaryStart(42, 75, 111);
    expect(getSummaryRun(42)).toEqual({ summaryId: 75, jobId: 111 });
  });
});
