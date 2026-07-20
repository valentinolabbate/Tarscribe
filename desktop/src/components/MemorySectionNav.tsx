import { ActivityIcon, MemoryIcon, SpeakerIdIcon, TasksIcon } from "./icons";
import type { ActionItem } from "../lib/types";

export type MemorySection = "radar" | "ledger" | "tasks" | "people" | "archive";
export type MemoryContentView = Extract<MemorySection, "radar" | "ledger" | "archive">;

export function memorySectionForActionItem(
  item: Pick<ActionItem, "kind" | "recipient">,
): MemorySection {
  if (item.kind === "decision") return "ledger";
  return item.recipient?.trim() ? "radar" : "tasks";
}

const sections: Array<{
  id: MemorySection;
  label: string;
  icon?: typeof ActivityIcon;
}> = [
  { id: "radar", label: "Commitment Radar", icon: ActivityIcon },
  { id: "ledger", label: "Decision Ledger", icon: MemoryIcon },
  { id: "tasks", label: "Aufgaben", icon: TasksIcon },
  { id: "people", label: "Personen", icon: SpeakerIdIcon },
  { id: "archive", label: "Archiv" },
];

export function MemorySectionNav({
  active,
  onSelect,
}: {
  active: MemorySection;
  onSelect: (section: MemorySection) => void;
}) {
  return (
    <nav className="memory-section-nav" aria-label="Unterseiten von Gedächtnis">
      {sections.map((section) => {
        const Icon = section.icon;
        const selected = active === section.id;
        return (
          <button
            key={section.id}
            type="button"
            className={selected ? "active" : ""}
            aria-current={selected ? "page" : undefined}
            onClick={() => onSelect(section.id)}
          >
            {Icon && <Icon width={15} height={15} />}
            {section.label}
          </button>
        );
      })}
    </nav>
  );
}
