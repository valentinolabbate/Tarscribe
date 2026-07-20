import type { ActionItem } from "../../lib/types";

export type OwnerFilter = "mine" | "all";
export type TaskView = "open" | "overdue" | "week" | "done";

export interface TaskCounts {
  total: number;
  open: number;
  overdue: number;
  week: number;
  done: number;
}

export interface TaskSection {
  id: "overdue" | "week" | "later" | "undated" | "done";
  title: string;
  detail: string;
  items: ActionItem[];
  tone?: "urgent" | "accent";
}

function isIsoDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function localIsoDate(date = new Date()): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function isoDateInDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

export function isOverdueOn(item: ActionItem, today: string): boolean {
  return !item.done && isIsoDate(item.due_date) && item.due_date < today;
}

function isDueThisWeek(item: ActionItem, today: string): boolean {
  const weekLimit = isoDateInDays(today, 7);
  return (
    !item.done &&
    isIsoDate(item.due_date) &&
    item.due_date >= today &&
    item.due_date <= weekLimit
  );
}

export function filterOwnedItems(items: ActionItem[], owner: OwnerFilter): ActionItem[] {
  return owner === "all" ? items : items.filter((item) => item.is_mine || item.include_in_tasks);
}

export function getTaskCounts(items: ActionItem[], today: string): TaskCounts {
  const matching = items.filter((item) => item.kind === "task");
  return {
    total: matching.length,
    open: matching.filter((item) => !item.done).length,
    overdue: matching.filter((item) => isOverdueOn(item, today)).length,
    week: matching.filter((item) => isDueThisWeek(item, today)).length,
    done: matching.filter((item) => item.done).length,
  };
}

function matchesSearch(item: ActionItem, search: string): boolean {
  if (!search) return true;
  return [item.text, item.assignee, item.recording_title, item.topic_name]
    .filter(Boolean)
    .some((value) => value!.toLocaleLowerCase("de-DE").includes(search));
}

function urgencyRank(item: ActionItem, today: string): number {
  if (isOverdueOn(item, today)) return 0;
  if (isDueThisWeek(item, today)) return 1;
  if (isIsoDate(item.due_date)) return 2;
  return 3;
}

export function filterTaskItems(
  items: ActionItem[],
  view: TaskView,
  search: string,
  today: string,
): ActionItem[] {
  const normalizedSearch = search.trim().toLocaleLowerCase("de-DE");
  return items
    .filter((item) => item.kind === "task")
    .filter((item) => {
      if (view === "done") return item.done;
      if (view === "overdue") return isOverdueOn(item, today);
      if (view === "week") return isDueThisWeek(item, today);
      return !item.done;
    })
    .filter((item) => matchesSearch(item, normalizedSearch))
    .sort((a, b) => {
      if (view === "open") {
        const urgency = urgencyRank(a, today) - urgencyRank(b, today);
        if (urgency !== 0) return urgency;
      }
      if (isIsoDate(a.due_date) && isIsoDate(b.due_date) && a.due_date !== b.due_date) {
        return a.due_date.localeCompare(b.due_date);
      }
      if (isIsoDate(a.due_date) !== isIsoDate(b.due_date)) return isIsoDate(a.due_date) ? -1 : 1;
      return b.created_at.localeCompare(a.created_at);
    });
}

export function buildTaskSections(
  items: ActionItem[],
  view: TaskView,
  today: string,
): TaskSection[] {
  if (view !== "open") {
    const labels = {
      overdue: ["Überfällige Aufgaben", "Frist bereits überschritten"],
      week: ["In den nächsten 7 Tagen", "Ab heute fällig"],
      done: ["Erledigte Aufgaben", "Bereits abgeschlossen"],
    } as const;
    return items.length
      ? [
          {
            id: view,
            title: labels[view][0],
            detail: labels[view][1],
            items,
            tone: view === "overdue" ? "urgent" : view === "week" ? "accent" : undefined,
          },
        ]
      : [];
  }

  const weekLimit = isoDateInDays(today, 7);
  const overdue = items.filter((item) => isOverdueOn(item, today));
  const week = items.filter((item) => isDueThisWeek(item, today));
  const later = items.filter(
    (item) => isIsoDate(item.due_date) && item.due_date > weekLimit,
  );
  const undated = items.filter((item) => !isIsoDate(item.due_date));

  const sections: TaskSection[] = [
    {
      id: "overdue",
      title: "Überfällig",
      detail: "Frist bereits überschritten",
      items: overdue,
      tone: "urgent",
    },
    {
      id: "week",
      title: "In den nächsten 7 Tagen",
      detail: "Ab heute fällig",
      items: week,
      tone: "accent",
    },
    { id: "later", title: "Später", detail: "Mit späterer Frist", items: later },
    { id: "undated", title: "Ohne Frist", detail: "Noch nicht terminiert", items: undated },
  ];
  return sections.filter((section) => section.items.length > 0);
}
