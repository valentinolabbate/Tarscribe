import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MemorySectionNav, memorySectionForActionItem } from "../MemorySectionNav";

const noop = vi.fn();

describe("memory navigation", () => {
  it("groups tasks and people under the single sidebar entry", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        topics={[]}
        activeTopic={null}
        showHome={false}
        showTasks
        showMemory={false}
        showPeople={false}
        showJobs={false}
        onHome={noop}
        onMemory={noop}
        onJobs={noop}
        onNewTopic={noop}
        onSelectTopic={noop}
        onMoveTopic={noop}
        onSettings={noop}
      />,
    );

    expect(html).toContain('aria-current="page"');
    expect(html.match(/Gedächtnis/g)).toHaveLength(1);
    expect(html).not.toContain(">Aufgaben<");
    expect(html).not.toContain(">Personen<");
  });

  it("keeps the topbar focused on the parent area", () => {
    const html = renderToStaticMarkup(
      <TopBar
        showJobs={false}
        showTasks={false}
        showMemory={false}
        showPeople
        showHome={false}
        openRecording={null}
        currentTopic={undefined}
        showRecordingIndicator={false}
        onTopicExport={noop}
        navigationOpen={false}
        onToggleNavigation={noop}
      />,
    );

    expect(html).toContain("<h1>Gedächtnis</h1>");
    expect(html).not.toContain("Gedächtnisbereiche");
    expect(html).not.toContain(">Aufgaben<");
    expect(html).not.toContain(">Personen<");
    expect(html).toContain('aria-label="Navigation öffnen"');
  });

  it("places tasks and people beside radar and ledger as memory subpages", () => {
    const html = renderToStaticMarkup(
      <MemorySectionNav active="people" onSelect={noop} />,
    );

    expect(html).toContain("Unterseiten von Gedächtnis");
    expect(html).toContain("Commitment Radar");
    expect(html).toContain("Decision Ledger");
    expect(html).toContain("Aufgaben");
    expect(html).toContain('class="active" aria-current="page">');
    expect(html).toContain("Personen</button>");
    expect(html).toContain("Archiv");
  });

  it("routes work items to their matching memory subpage", () => {
    expect(memorySectionForActionItem({ kind: "task", recipient: null })).toBe("tasks");
    expect(memorySectionForActionItem({ kind: "task", recipient: "Ada" })).toBe("radar");
    expect(memorySectionForActionItem({ kind: "decision", recipient: null })).toBe("ledger");
  });
});
