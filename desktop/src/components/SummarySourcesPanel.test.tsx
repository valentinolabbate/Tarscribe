import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SummarySource } from "../lib/types";
import { SummarySourcesPanel } from "./SummarySourcesPanel";

function text(markup: string) {
  return markup.replace(/\s+/g, " ");
}

function makeSources(n: number, type: SummarySource["source_type"] = "transcript"): SummarySource[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    recording_id: type === "web" ? null : 3,
    recording_title: type === "web" ? null : `Aufnahme ${i + 1}`,
    source_url: type === "web" ? `https://example.com/page-${i + 1}` : null,
    source_type: type,
  }));
}

describe("SummarySourcesPanel", () => {
  it("renders nothing when there are no sources", () => {
    const html = renderToStaticMarkup(
      <SummarySourcesPanel raw={null} onOpenSource={vi.fn()} />,
    );
    expect(html).toBe("");
  });

  it("shows all sources when fewer than 5 and no toggle", () => {
    const sources = makeSources(3);
    const html = renderToStaticMarkup(
      <SummarySourcesPanel raw={JSON.stringify(sources)} onOpenSource={vi.fn()} />,
    );
    expect(text(html)).toContain("Quellen · 3");
    expect(text(html)).toContain("3 Wissensbasis");
    expect(text(html)).toContain("[1]");
    expect(text(html)).toContain("[2]");
    expect(text(html)).toContain("[3]");
    expect(text(html)).not.toContain("Alle");
    expect(text(html)).not.toContain("[4]");
  });

  it("shows only 5 sources and a toggle when more than 5", () => {
    const sources = makeSources(8);
    const html = renderToStaticMarkup(
      <SummarySourcesPanel raw={JSON.stringify(sources)} onOpenSource={vi.fn()} />,
    );
    expect(text(html)).toContain("Quellen · 8");
    expect(text(html)).toContain("[5]");
    expect(text(html)).not.toContain("[6]");
    expect(text(html)).toContain("Alle 8 Quellen anzeigen");
  });

  it("distinguishes web and knowledge sources in the breakdown", () => {
    const sources = [
      ...makeSources(2, "web"),
      ...makeSources(3, "transcript"),
    ] as SummarySource[];
    const html = renderToStaticMarkup(
      <SummarySourcesPanel raw={JSON.stringify(sources)} onOpenSource={vi.fn()} />,
    );
    expect(text(html)).toContain("Quellen · 5");
    expect(text(html)).toContain("2 Web");
    expect(text(html)).toContain("3 Wissensbasis");
  });

  it("shows Web öffnen action for web sources", () => {
    const sources: SummarySource[] = [
      {
        index: 1,
        recording_id: null,
        recording_title: null,
        source_url: "https://hochsauerlandwasser.de/",
        source_type: "web",
      },
    ];
    const html = renderToStaticMarkup(
      <SummarySourcesPanel raw={JSON.stringify(sources)} onOpenSource={vi.fn()} />,
    );
    expect(text(html)).toContain("hochsauerlandwasser.de");
    expect(text(html)).toContain("Web öffnen");
  });

  it("shows Aufnahme öffnen action for transcript sources", () => {
    const sources: SummarySource[] = [
      {
        index: 1,
        recording_id: 3,
        recording_title: "Standup",
        source_type: "transcript",
      },
    ];
    const html = renderToStaticMarkup(
      <SummarySourcesPanel raw={JSON.stringify(sources)} onOpenSource={vi.fn()} />,
    );
    expect(text(html)).toContain("Standup");
    expect(text(html)).toContain("Aufnahme öffnen");
  });
});
