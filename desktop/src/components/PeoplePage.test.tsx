import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PeopleMemory } from "../lib/types";
import { PeopleMemoryView } from "./PeoplePage";

const memory: PeopleMemory = {
  speaker: { id: 1, name: "Ada Lovelace", color: "#8b5cf6", sample_count: 3 },
  stats: {
    recording_count: 2,
    open_task_count: 1,
    decision_count: 1,
    thread_count: 1,
    talk_sec: 120,
    last_seen_at: "2026-07-05T10:00:00Z",
  },
  recordings: [
    {
      id: 7,
      title: "Produkt-Meeting",
      created_at: "2026-07-05T10:00:00Z",
      duration_sec: 1800,
      topic_id: 2,
      topic_name: "Produkt",
      topic_color: "#0f766e",
      start_sec: 42,
      talk_sec: 120,
    },
  ],
  tasks: [
    {
      id: 9,
      recording_id: 7,
      kind: "task",
      text: "Prototyp fertigstellen",
      assignee: "Ada",
      due: null,
      due_date: "2026-07-10",
      done: false,
      is_mine: false,
      include_in_tasks: false,
      calendar_status: "idle",
      calendar_error: null,
      calendar_exported_at: null,
      created_at: "2026-07-05T10:00:00Z",
      recording_title: "Produkt-Meeting",
      topic_id: 2,
      topic_name: "Produkt",
      topic_color: "#0f766e",
    },
  ],
  decisions: [
    {
      id: 10,
      recording_id: 7,
      kind: "decision",
      text: "Der Launch erfolgt im Herbst",
      assignee: null,
      due: null,
      due_date: null,
      done: false,
      is_mine: false,
      include_in_tasks: false,
      calendar_status: "idle",
      calendar_error: null,
      calendar_exported_at: null,
      created_at: "2026-07-05T10:00:00Z",
      recording_title: "Produkt-Meeting",
      topic_id: 2,
      topic_name: "Produkt",
      topic_color: "#0f766e",
    },
  ],
  threads: [
    {
      id: 3,
      title: "Produktstrategie",
      updated_at: "2026-07-05T10:00:00Z",
      created_at: "2026-07-01T10:00:00Z",
      mention_count: 1,
      recording_count: 1,
      mentions: [
        {
          id: 4,
          thread_id: 3,
          recording_id: 7,
          recording_title: "Produkt-Meeting",
          topic_id: 2,
          topic_name: "Produkt",
          topic_color: "#0f766e",
          start_sec: 85,
          text: "Produktstrategie",
          created_at: "2026-07-05T10:00:00Z",
          recording_created_at: "2026-07-05T10:00:00Z",
        },
      ],
    },
  ],
};

describe("People Memory", () => {
  it("renders sourced conversations, tasks, decisions and threads", () => {
    const html = renderToStaticMarkup(
      <PeopleMemoryView memory={memory} onOpenRecording={vi.fn()} />,
    ).replace(/\s+/g, " ");

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Prototyp fertigstellen");
    expect(html).toContain("Der Launch erfolgt im Herbst");
    expect(html).toContain("Produktstrategie");
    expect(html).not.toContain("Keine Persönlichkeitsbewertung");
    expect(html).toContain("2:00 gesprochen");
  });

  it("limits profile sections to three entries before expanding", () => {
    const overflowingMemory: PeopleMemory = {
      ...memory,
      stats: {
        ...memory.stats,
        recording_count: 4,
        open_task_count: 4,
        decision_count: 4,
        thread_count: 4,
      },
      recordings: Array.from({ length: 4 }, (_, index) => ({
        ...memory.recordings[0],
        id: 100 + index,
        title: `Gespräch ${index + 1}`,
      })),
      tasks: Array.from({ length: 4 }, (_, index) => ({
        ...memory.tasks[0],
        id: 200 + index,
        text: `Aufgabe ${index + 1}`,
      })),
      decisions: Array.from({ length: 4 }, (_, index) => ({
        ...memory.decisions[0],
        id: 300 + index,
        text: `Entscheidung ${index + 1}`,
      })),
      threads: Array.from({ length: 4 }, (_, index) => ({
        ...memory.threads[0],
        id: 400 + index,
        title: `Thema ${index + 1}`,
      })),
    };

    const html = renderToStaticMarkup(
      <PeopleMemoryView memory={overflowingMemory} onOpenRecording={vi.fn()} />,
    ).replace(/\s+/g, " ");

    expect(html).toContain("Aufgabe 3");
    expect(html).not.toContain("Aufgabe 4");
    expect(html).toContain("Gespräch 3");
    expect(html).not.toContain("Gespräch 4");
    expect(html).toContain("Thema 3");
    expect(html).not.toContain("Thema 4");
    expect(html).toContain("Entscheidung 3");
    expect(html).not.toContain("Entscheidung 4");
    expect(html.match(/1 weiteren Eintrag anzeigen/g)?.length).toBe(4);
  });
});
