import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemoryEnrichmentRun } from "../lib/types";
import {
  MemoryEnrichmentCompletion,
  parseDismissedMemoryEnrichmentRunId,
} from "./MemoryPage";

const completedRun: MemoryEnrichmentRun = {
  id: 12,
  status: "done",
  total_recordings: 1,
  processed_recordings: 1,
  total_items: 1,
  enriched_items: 1,
  unmatched_items: 0,
  failed_recordings: 0,
  progress: 1,
  error: null,
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:01:00Z",
};

describe("MemoryEnrichmentCompletion", () => {
  it("renders a persistent dismissal control and correct singular copy", () => {
    const html = renderToStaticMarkup(
      <MemoryEnrichmentCompletion run={completedRun} onDismiss={vi.fn()} />,
    );

    expect(html).toContain("1 Belegspur ergänzt");
    expect(html).toContain('aria-label="Meldung dauerhaft schließen"');
  });

  it("renders plural copy for multiple enriched items", () => {
    const html = renderToStaticMarkup(
      <MemoryEnrichmentCompletion
        run={{ ...completedRun, enriched_items: 3, total_items: 3 }}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain("3 Belegspuren ergänzt");
  });
});

describe("parseDismissedMemoryEnrichmentRunId", () => {
  it("accepts only positive integer run ids", () => {
    expect(parseDismissedMemoryEnrichmentRunId("12")).toBe(12);
    expect(parseDismissedMemoryEnrichmentRunId(null)).toBeNull();
    expect(parseDismissedMemoryEnrichmentRunId("0")).toBeNull();
    expect(parseDismissedMemoryEnrichmentRunId("invalid")).toBeNull();
  });
});
