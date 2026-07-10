import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TasksScoreboard } from "./TasksScoreboard";

const counts = { total: 12, open: 7, overdue: 2, week: 3, done: 5 };

describe("TasksScoreboard", () => {
  it("marks the selected task focus accessibly", () => {
    const html = renderToStaticMarkup(
      <TasksScoreboard counts={counts} kind="task" selected="overdue" onSelect={vi.fn()} />,
    );

    expect(html).toContain("Überfällig");
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/<button/g)?.length).toBe(4);
  });

  it("reduces decisions to current and archived views", () => {
    const html = renderToStaticMarkup(
      <TasksScoreboard counts={counts} kind="decision" selected="open" onSelect={vi.fn()} />,
    );

    expect(html).toContain("Aktuell");
    expect(html).toContain("Archiviert");
    expect(html).not.toContain("Überfällig");
    expect(html.match(/<button/g)?.length).toBe(2);
  });
});
