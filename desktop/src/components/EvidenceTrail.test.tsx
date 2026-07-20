import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EvidenceTrail } from "./EvidenceTrail";

describe("EvidenceTrail", () => {
  it("renders a linked source with timestamp and context", () => {
    const html = renderToStaticMarkup(
      <EvidenceTrail
        recordingId={7}
        recordingTitle="Produktgespräch"
        startSec={84}
        quote="Wir starten im Herbst."
        topicName="Produkt"
        topicColor="#0f766e"
        speaker="Ada"
        onOpenRecording={vi.fn()}
      />,
    );

    expect(html).toContain("1:24");
    expect(html).toContain("Produktgespräch");
    expect(html).toContain("Wir starten im Herbst.");
    expect(html).toContain("evidence-trail-signal");
    expect(html).toContain("<button");
  });

  it("does not present a missing source as an action", () => {
    const html = renderToStaticMarkup(
      <EvidenceTrail
        recordingId={7}
        recordingTitle={null}
        missing
        onOpenRecording={vi.fn()}
      />,
    );

    expect(html).toContain("Belegspur fehlt");
    expect(html).not.toContain("<button");
  });

  it("renders a static non-recording source with its source type", () => {
    const html = renderToStaticMarkup(
      <EvidenceTrail
        recordingTitle="strategie.pdf"
        positionLabel="Dok."
        sourceType="Dokument"
        quote="Der Rollout startet im Herbst."
      />,
    );

    expect(html).toContain("Dok.");
    expect(html).toContain("strategie.pdf");
    expect(html).toContain("Dokument");
    expect(html).toContain("static");
    expect(html).not.toContain("<button");
  });
});
