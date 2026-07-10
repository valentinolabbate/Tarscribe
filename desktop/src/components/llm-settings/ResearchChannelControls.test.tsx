import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchChannelControls } from "./ResearchChannelControls";

describe("ResearchChannelControls", () => {
  it("shows both research channels in one compact control", () => {
    const html = renderToStaticMarkup(
      <ResearchChannelControls
        knowledgeEnabled
        webEnabled={false}
        profileLabel="Zusammenfassungen"
        onKnowledgeChange={() => undefined}
        onWebChange={() => undefined}
      />,
    );

    expect(html).toContain("llm-research-strip");
    expect(html).toContain("Recherche für Zusammenfassungen");
    expect(html).toContain("Wissen");
    expect(html).toContain("Web");
    expect(html).toContain("1/2");
    expect((html.match(/type=\"checkbox\"/g) ?? []).length).toBe(2);
  });
});
