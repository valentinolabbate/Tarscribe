import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TasksScoreboard } from "./TasksScoreboard";

const counts = { total: 12, open: 7, overdue: 2, week: 3, done: 5 };

describe("TasksScoreboard", () => {
  it("marks the selected task focus accessibly", () => {
    const html = renderToStaticMarkup(
      <TasksScoreboard counts={counts} selected="overdue" onSelect={vi.fn()} />,
    );

    expect(html).toContain("Überfällig");
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/<button/g)?.length).toBe(4);
  });

});
